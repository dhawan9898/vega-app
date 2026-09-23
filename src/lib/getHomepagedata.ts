import {Post} from './providers/types';
import {providerManager} from './services/ProviderManager';
import {ProviderExtension} from './storage/extensionStorage';
import {mergePostsRoundRobin} from './services/MultiProviderAggregator';

export interface HomePageData {
  title: string;
  Posts: Post[];
  filter: string;
  error?: string;
}

// Section titles are generic (not provider catalog names) because each
// installed provider defines its own catalog differently; we take each
// provider's first two catalog filters as "their" recommended + secondary
// sections and merge same-named titles across providers into each one.
export const HOME_SECTION_TITLES = ['Recommended for you', 'More to explore'];
const PROVIDER_FETCH_CONCURRENCY = 6;
const POSTS_PER_SECTION_LIMIT = 30;

const fetchProviderSections = async (
  providerValue: string,
  signal: AbortSignal,
): Promise<Post[][]> => {
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
};

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
): Promise<HomePageData[]> => {
  const perProviderSections: Array<{providerValue: string; sections: Post[][]}> =
    [];

  for (let i = 0; i < installedProviders.length; i += PROVIDER_FETCH_CONCURRENCY) {
    const batch = installedProviders.slice(i, i + PROVIDER_FETCH_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async provider => ({
        providerValue: provider.value,
        sections: await fetchProviderSections(provider.value, signal),
      })),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        perProviderSections.push(result.value);
      }
    }

    if (signal.aborted) {
      throw new Error('Request aborted');
    }
  }

  const homePageData: HomePageData[] = HOME_SECTION_TITLES.map(
    (title, sectionIndex) => {
      const perProvider = perProviderSections
        .map(entry => ({
          providerValue: entry.providerValue,
          posts: entry.sections[sectionIndex] || [],
        }))
        .filter(entry => entry.posts.length > 0);

      const merged = mergePostsRoundRobin(perProvider, POSTS_PER_SECTION_LIMIT);
      return {title, Posts: merged, filter: title};
    },
  ).filter(section => section.Posts.length > 0);

  if (homePageData.length === 0) {
    throw new Error('Failed to load any content from installed providers');
  }

  return homePageData;
};
