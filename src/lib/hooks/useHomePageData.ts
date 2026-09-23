import {useEffect, useRef} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  getHomePageData,
  retryStaleProviders,
  HomePageData,
} from '../getHomepagedata';
import {ProviderExtension} from '../storage/extensionStorage';
import {cacheStorage} from '../storage';

interface UseHomePageDataOptions {
  installedProviders: Pick<ProviderExtension, 'value'>[];
  enabled?: boolean;
}

// Give the initial render a chance to settle before quietly retrying
// whichever providers timed out, instead of hammering them immediately.
const BACKGROUND_RETRY_DELAY_MS = 15_000;

export const useHomePageData = ({
  installedProviders,
  enabled = true,
}: UseHomePageDataOptions) => {
  const providerKey = installedProviders
    .map(item => item.value)
    .sort()
    .join(',');
  const cacheKey = 'homeData:' + providerKey;
  const queryClient = useQueryClient();
  const staleProviderValuesRef = useRef<string[]>([]);
  const queryKey = ['homePageData', providerKey];

  const query = useQuery<HomePageData[], Error>({
    queryKey,
    queryFn: async ({signal}) => {
      // Fetch fresh data aggregated across every installed provider. Cached
      // per-provider results (from a prior successful load) back-fill any
      // provider that times out this round, so Home shows what it can
      // immediately instead of dropping content that used to be there.
      const {sections, staleProviderValues} = await getHomePageData(
        installedProviders,
        signal,
      );
      staleProviderValuesRef.current = staleProviderValues;
      return sections;
    },
    enabled: enabled && installedProviders.length > 0,
    staleTime: 0, // Mark stale immediately so it revalidates in the background
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: (failureCount, error) => {
      if (error.name === 'AbortError') {
        return false;
      }
      return failureCount < 3;
    },
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
    // Add initial data from cache for instant loading without loading screen
    initialData: () => {
      const cache = cacheStorage.getString(cacheKey);
      if (cache) {
        try {
          return JSON.parse(cache);
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    initialDataUpdatedAt: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'always',
  });

  // After a load leaves some providers stale (timed out), quietly retry just
  // those in the background. If any come through, invalidate so the next
  // aggregation (now warm-cached for them) re-merges them in. A retry that
  // improves nothing doesn't reschedule itself - this isn't a polling loop.
  useEffect(() => {
    const staleValues = staleProviderValuesRef.current;
    if (staleValues.length === 0) {
      return;
    }
    staleProviderValuesRef.current = [];

    const controller = new AbortController();
    const timer = setTimeout(() => {
      retryStaleProviders(staleValues, controller.signal)
        .then(improved => {
          if (improved) {
            queryClient.invalidateQueries({queryKey});
          }
        })
        .catch(() => {});
    }, BACKGROUND_RETRY_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query.dataUpdatedAt]);

  useEffect(() => {
    if (query.data && query.data.length > 0 && installedProviders.length > 0) {
      cacheStorage.setString(cacheKey, JSON.stringify(query.data));
    }
  }, [cacheKey, installedProviders.length, query.data]);

  return query;
};

// Store hero selection per provider to prevent re-randomization on tab switch
const heroSelectionCache = new Map<
  string,
  {postIndex: number; categoryIndex: number}
>();

// Memoized hero selection with stable reference - uses cached index to prevent re-randomization
export const getRandomHeroPost = (
  homeData: HomePageData[],
  providerValue?: string,
) => {
  if (!homeData || homeData.length === 0) {
    return null;
  }

  const populatedCategories = homeData
    .map((category, categoryIndex) => ({category, categoryIndex}))
    .filter(({category}) => category.Posts?.length > 0);
  if (populatedCategories.length === 0) {
    return null;
  }

  const cacheKey = providerValue || 'default';
  const cached = heroSelectionCache.get(cacheKey);

  // If we have a cached index and it's still valid for this data, use it
  const cachedCategory = cached ? homeData[cached.categoryIndex] : undefined;
  if (
    cached &&
    cachedCategory?.Posts &&
    cached.postIndex < cachedCategory.Posts.length
  ) {
    return cachedCategory.Posts[cached.postIndex];
  }

  // Otherwise, choose a random populated catalog and a random post within it.
  const randomCategory =
    populatedCategories[Math.floor(Math.random() * populatedCategories.length)];
  const randomPostIndex = Math.floor(
    Math.random() * randomCategory.category.Posts.length,
  );
  heroSelectionCache.set(cacheKey, {
    postIndex: randomPostIndex,
    categoryIndex: randomCategory.categoryIndex,
  });

  return randomCategory.category.Posts[randomPostIndex];
};

// Function to clear hero cache when explicitly refreshing
export const clearHeroCache = (providerValue?: string) => {
  if (providerValue) {
    heroSelectionCache.delete(providerValue);
  } else {
    heroSelectionCache.clear();
  }
};

// Hook for hero metadata with React Query, instant cache load & background revalidation
export const useHeroMetadata = (heroLink: string, providerValue: string) => {
  const cacheKey = `heroMeta:${providerValue}:${heroLink}`;
  const query = useQuery({
    queryKey: ['heroMetadata', heroLink, providerValue],
    queryFn: async () => {
      const {providerManager} = await import('../services/ProviderManager');
      const {default: axios} = await import('axios');

      const info = await providerManager.getMetaData({
        link: heroLink,
        provider: providerValue,
      });

      // Only enrich providers that explicitly opt in to Cinemeta metadata.
      if (info.populateMeta === true && info.imdbId && info.type) {
        try {
          const response = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${info.type}/${info.imdbId}.json`,
            {timeout: 5000},
          );
          return response.data?.meta || info;
        } catch {
          return info; // Fallback to original info if Stremio fails
        }
      }

      return info;
    },
    enabled: !!heroLink && !!providerValue,
    staleTime: 0, // Instantly revalidate in background
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: 2,
    // Use cached data as initial data
    initialData: () => {
      const cached =
        cacheStorage.getString(cacheKey) || cacheStorage.getString(heroLink);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    initialDataUpdatedAt: 0,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (query.data && heroLink) {
      cacheStorage.setString(cacheKey, JSON.stringify(query.data));
      cacheStorage.setString(heroLink, JSON.stringify(query.data));
    }
  }, [cacheKey, heroLink, query.data]);

  return query;
};
