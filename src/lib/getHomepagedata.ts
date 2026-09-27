import {Catalog, Post} from './providers/types';
import {providerManager} from './services/ProviderManager';
import {ProviderExtension} from './storage/extensionStorage';
import {cacheStorage} from './storage';
import {
  mergePostsRoundRobin,
  normalizeTitle,
} from './services/MultiProviderAggregator';

export interface HomePageData {
  title: string;
  Posts: Post[];
  filter: string;
  error?: string;
}

export interface HomePageResult {
  sections: HomePageData[];
  // Providers whose live fetch didn't finish in time this round (we fell
  // back to their last cached result, or to nothing if none exists). The
  // caller can retry just these later instead of re-fetching everyone.
  staleProviderValues: string[];
}

// Section titles are generic (not provider catalog names) because each
// installed provider defines its own catalog differently; we take each
// provider's first two catalog filters as "their" recommended + secondary
// sections and merge same-named titles across providers into each one.
export const HOME_SECTION_TITLES = ['Recommended for you', 'More to explore'];
const PROVIDER_FETCH_CONCURRENCY = 10;
const POSTS_PER_SECTION_LIMIT = 30;
// The sandbox itself allows a single invoke up to two minutes (legitimate
// slow scraping). That's fine for a one-off action, but Home aggregates
// across every installed provider - without a much shorter cap here, one
// slow or dead provider would stall its whole concurrency batch for up to
// two minutes before the rest could even be attempted.
const PER_PROVIDER_TIMEOUT_MS = 8_000;

/**
 * Races `attempt` against a fixed per-provider timeout, aborting it (via the
 * signal passed into `attempt`) if it doesn't finish in time. Also aborts
 * early if `outerSignal` fires. Every per-provider fetch in this module goes
 * through this so one slow or dead provider can never stall the others.
 */
const raceWithProviderTimeout = async <T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  outerSignal: AbortSignal,
): Promise<{result: T; timedOut: boolean}> => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  outerSignal.addEventListener('abort', forwardAbort);

  let timedOut = false;
  const timeout = new Promise<T>(resolve => {
    setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(fallback);
    }, PER_PROVIDER_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([attempt(controller.signal), timeout]);
    return {result, timedOut};
  } finally {
    outerSignal.removeEventListener('abort', forwardAbort);
  }
};

const providerSectionsCacheKey = (providerValue: string) =>
  `homeProviderSections:${providerValue}`;

const readCachedSections = (providerValue: string): Post[][] => {
  const cached = cacheStorage.getString(providerSectionsCacheKey(providerValue));
  if (!cached) {
    return [];
  }
  try {
    const parsed = JSON.parse(cached);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeCachedSections = (providerValue: string, sections: Post[][]): void => {
  cacheStorage.setString(
    providerSectionsCacheKey(providerValue),
    JSON.stringify(sections),
  );
};

interface ProviderFetchResult {
  sections: Post[][];
  // True when the live fetch timed out this round - sections is either the
  // last cached result for this provider or empty, not fresh data.
  stale: boolean;
}

const fetchProviderSections = async (
  providerValue: string,
  outerSignal: AbortSignal,
): Promise<ProviderFetchResult> => {
  const {result: sections, timedOut} = await raceWithProviderTimeout<Post[][]>(
    async signal => {
      try {
        const catalog = await providerManager.getCatalog({providerValue});
        const filters = catalog.slice(0, HOME_SECTION_TITLES.length);
        return await Promise.all(
          filters.map(async filter => {
            try {
              const posts = await providerManager.getPosts({
                filter: filter.filter,
                page: 1,
                providerValue,
                signal,
              });
              return posts || [];
            } catch (error) {
              console.error(
                `Failed to load "${filter.title}" from ${providerValue}:`,
                error,
              );
              return [];
            }
          }),
        );
      } catch (error) {
        console.error(`Failed to load catalog for ${providerValue}:`, error);
        return [];
      }
    },
    [],
    outerSignal,
  );

  if (timedOut) {
    // Didn't finish in time - fall back to whatever we last saw from this
    // provider rather than dropping it from Home entirely.
    return {sections: readCachedSections(providerValue), stale: true};
  }

  if (sections.some(list => list.length > 0)) {
    writeCachedSections(providerValue, sections);
  }
  return {sections, stale: false};
};

const mergeSections = (
  perProviderSections: Array<{providerValue: string; sections: Post[][]}>,
): HomePageData[] =>
  HOME_SECTION_TITLES.map((title, sectionIndex) => {
    const perProvider = perProviderSections
      .map(entry => ({
        providerValue: entry.providerValue,
        posts: entry.sections[sectionIndex] || [],
      }))
      .filter(entry => entry.posts.length > 0);

    const merged = mergePostsRoundRobin(perProvider, POSTS_PER_SECTION_LIMIT);
    return {title, Posts: merged, filter: title};
  }).filter(section => section.Posts.length > 0);

/**
 * Builds the Home feed by pulling each installed provider's first couple of
 * catalog sections in parallel (bounded so we don't flood the sandbox with
 * every provider at once), then merging same-titled posts across providers
 * into shared sections - so Home shows recommendations aggregated from
 * every provider rather than a single manually-selected one.
 */
export const getHomePageData = async (
  installedProviders: Pick<ProviderExtension, 'value'>[],
  signal: AbortSignal,
): Promise<HomePageResult> => {
  const perProviderSections: Array<{providerValue: string; sections: Post[][]}> =
    [];
  const staleProviderValues: string[] = [];

  for (let i = 0; i < installedProviders.length; i += PROVIDER_FETCH_CONCURRENCY) {
    const batch = installedProviders.slice(i, i + PROVIDER_FETCH_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async provider => {
        const result = await fetchProviderSections(provider.value, signal);
        return {providerValue: provider.value, ...result};
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        perProviderSections.push(result.value);
        if (result.value.stale) {
          staleProviderValues.push(result.value.providerValue);
        }
      }
    }

    if (signal.aborted) {
      throw new Error('Request aborted');
    }
  }

  const sections = mergeSections(perProviderSections);

  if (sections.length === 0) {
    throw new Error('Failed to load any content from installed providers');
  }

  return {sections, staleProviderValues};
};

/**
 * Retries just the providers that timed out on the last aggregation, rather
 * than re-fetching everyone. Returns whether any of them produced fresh
 * data worth re-merging into the Home feed.
 */
export const retryStaleProviders = async (
  staleProviderValues: string[],
  signal: AbortSignal,
): Promise<boolean> => {
  if (staleProviderValues.length === 0) {
    return false;
  }

  const results = await Promise.allSettled(
    staleProviderValues.map(providerValue =>
      fetchProviderSections(providerValue, signal),
    ),
  );

  return results.some(
    result =>
      result.status === 'fulfilled' &&
      !result.value.stale &&
      result.value.sections.some(list => list.length > 0),
  );
};

// ---------------------------------------------------------------------------
// Netflix-style top category/genre bar
// ---------------------------------------------------------------------------

export interface CategoryOption {
  id: string;
  label: string;
}

interface ProviderFilterRef {
  providerValue: string;
  filter: string;
}

export interface CategoryCatalog {
  // In display order: "Movies" / "TV Shows" (only if at least one provider
  // matched) come first, then genres shared by 2+ providers, alphabetically.
  options: CategoryOption[];
  filtersByCategory: Map<string, ProviderFilterRef[]>;
}

const MOVIE_KEYWORDS = /\b(movies?|films?)\b/i;
const SHOW_KEYWORDS = /\b(tv[\s-]?shows?|series|shows?|dramas?)\b/i;
const MOVIES_CATEGORY_ID = '__movies';
const TV_SHOWS_CATEGORY_ID = '__tv_shows';
// A genre only becomes a chip once at least this many providers expose it,
// so the bar isn't cluttered with odd one-off catalog entries.
const MIN_PROVIDERS_FOR_GENRE_CHIP = 2;

/**
 * Discovers a Netflix-style top bar of category chips - "Movies" / "TV
 * Shows" (best-effort, matched by keyword against each provider's own
 * catalog and genre titles, since providers don't share a content-type
 * field) plus whatever genres multiple providers have in common (Action,
 * Comedy, Anime, ...), sourced from each provider's own getGenres().
 */
export const getCategoryCatalog = async (
  installedProviders: Pick<ProviderExtension, 'value'>[],
  signal: AbortSignal,
): Promise<CategoryCatalog> => {
  const genreEntries = new Map<
    string,
    {label: string; providers: ProviderFilterRef[]}
  >();
  const movieProviders: ProviderFilterRef[] = [];
  const showProviders: ProviderFilterRef[] = [];

  const classify = (providerValue: string, item: Catalog) => {
    if (!item?.title || !item?.filter) {
      return;
    }
    if (MOVIE_KEYWORDS.test(item.title)) {
      movieProviders.push({providerValue, filter: item.filter});
    }
    if (SHOW_KEYWORDS.test(item.title)) {
      showProviders.push({providerValue, filter: item.filter});
    }

    const key = normalizeTitle(item.title);
    if (!key) {
      return;
    }
    const existing = genreEntries.get(key);
    if (existing) {
      if (!existing.providers.some(p => p.providerValue === providerValue)) {
        existing.providers.push({providerValue, filter: item.filter});
      }
    } else {
      genreEntries.set(key, {
        label: item.title,
        providers: [{providerValue, filter: item.filter}],
      });
    }
  };

  for (
    let i = 0;
    i < installedProviders.length;
    i += PROVIDER_FETCH_CONCURRENCY
  ) {
    const batch = installedProviders.slice(i, i + PROVIDER_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async provider => {
        const {result} = await raceWithProviderTimeout<Catalog[]>(
          async () => {
            const [catalog, genres] = await Promise.all([
              providerManager
                .getCatalog({providerValue: provider.value})
                .catch(() => []),
              providerManager
                .getGenres({providerValue: provider.value})
                .catch(() => []),
            ]);
            return [...(catalog || []), ...(genres || [])];
          },
          [],
          signal,
        );

        for (const item of result) {
          classify(provider.value, item);
        }
      }),
    );

    if (signal.aborted) {
      throw new Error('Request aborted');
    }
  }

  const filtersByCategory = new Map<string, ProviderFilterRef[]>();
  const options: CategoryOption[] = [];

  if (movieProviders.length > 0) {
    filtersByCategory.set(MOVIES_CATEGORY_ID, movieProviders);
    options.push({id: MOVIES_CATEGORY_ID, label: 'Movies'});
  }
  if (showProviders.length > 0) {
    filtersByCategory.set(TV_SHOWS_CATEGORY_ID, showProviders);
    options.push({id: TV_SHOWS_CATEGORY_ID, label: 'TV Shows'});
  }

  const genreOptions = Array.from(genreEntries.entries())
    .filter(([, v]) => v.providers.length >= MIN_PROVIDERS_FOR_GENRE_CHIP)
    .sort((a, b) => a[1].label.localeCompare(b[1].label));

  for (const [id, v] of genreOptions) {
    filtersByCategory.set(id, v.providers);
    options.push({id, label: v.label});
  }

  return {options, filtersByCategory};
};

/**
 * Builds a single merged Home section for one selected category/genre chip,
 * using each provider's own filter string for that category. Reuses the
 * same per-provider timeout as the default feed, but has no stale-cache
 * fallback of its own (yet) - a provider that times out here just sits out
 * this particular category for this load.
 */
export const getHomePageDataForCategory = async (
  category: CategoryOption,
  providerFilters: ProviderFilterRef[],
  signal: AbortSignal,
): Promise<HomePageData> => {
  const perProvider: Array<{providerValue: string; posts: Post[]}> = [];

  for (
    let i = 0;
    i < providerFilters.length;
    i += PROVIDER_FETCH_CONCURRENCY
  ) {
    const batch = providerFilters.slice(i, i + PROVIDER_FETCH_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async ({providerValue, filter}) => {
        const {result: posts} = await raceWithProviderTimeout<Post[]>(
          fetchSignal =>
            providerManager
              .getPosts({filter, page: 1, providerValue, signal: fetchSignal})
              .catch(error => {
                console.error(
                  `Failed to load category "${category.label}" from ${providerValue}:`,
                  error,
                );
                return [];
              }),
          [],
          signal,
        );
        return {providerValue, posts: posts || []};
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        perProvider.push(result.value);
      }
    }

    if (signal.aborted) {
      throw new Error('Request aborted');
    }
  }

  const merged = mergePostsRoundRobin(
    perProvider.filter(entry => entry.posts.length > 0),
    POSTS_PER_SECTION_LIMIT,
  );

  return {title: category.label, Posts: merged, filter: category.id};
};
