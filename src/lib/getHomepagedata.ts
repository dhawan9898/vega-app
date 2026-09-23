import {Post} from './providers/types';
import {providerManager} from './services/ProviderManager';
import {ProviderExtension} from './storage/extensionStorage';
import {cacheStorage} from './storage';
import {mergePostsRoundRobin} from './services/MultiProviderAggregator';

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
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  outerSignal.addEventListener('abort', forwardAbort);

  const attempt = (async (): Promise<Post[][]> => {
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
              signal: controller.signal,
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
  })();

  let timedOut = false;
  const timeout = new Promise<Post[][]>(resolve => {
    setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve([]);
    }, PER_PROVIDER_TIMEOUT_MS);
  });

  let sections: Post[][];
  try {
    sections = await Promise.race([attempt, timeout]);
  } finally {
    outerSignal.removeEventListener('abort', forwardAbort);
  }

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
