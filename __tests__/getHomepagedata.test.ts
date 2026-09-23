import {
  getHomePageData,
  retryStaleProviders,
  HOME_SECTION_TITLES,
} from '../src/lib/getHomepagedata';

const mockGetCatalog = jest.fn();
const mockGetPosts = jest.fn();

jest.mock('../src/lib/services/ProviderManager', () => ({
  providerManager: {
    getCatalog: (...args: unknown[]) => mockGetCatalog(...args),
    getPosts: (...args: unknown[]) => mockGetPosts(...args),
  },
}));

const mockCacheStore = new Map<string, string>();

jest.mock('../src/lib/storage', () => ({
  cacheStorage: {
    getString: (key: string) => mockCacheStore.get(key),
    setString: (key: string, value: string) => {
      mockCacheStore.set(key, value);
    },
  },
}));

describe('getHomePageData', () => {
  beforeEach(() => {
    mockGetCatalog.mockReset();
    mockGetPosts.mockReset();
    mockCacheStore.clear();
  });

  it('merges the first catalog section from every provider into a shared "Recommended" section', async () => {
    mockGetCatalog.mockImplementation(async ({providerValue}) => {
      if (providerValue === 'alpha') {
        return [{title: 'Popular', filter: 'popular'}];
      }
      return [{title: 'Trending Now', filter: 'trending'}];
    });
    mockGetPosts.mockImplementation(async ({providerValue}) => {
      if (providerValue === 'alpha') {
        return [{title: 'Alpha Movie', link: '/a/1', image: ''}];
      }
      return [{title: 'Beta Movie', link: '/b/1', image: ''}];
    });

    const result = await getHomePageData(
      [{value: 'alpha'}, {value: 'beta'}],
      new AbortController().signal,
    );

    expect(result.staleProviderValues).toEqual([]);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].title).toBe(HOME_SECTION_TITLES[0]);
    expect(result.sections[0].Posts.map(p => p.title)).toEqual([
      'Alpha Movie',
      'Beta Movie',
    ]);
  });

  it('drops a provider that fails to load its catalog and still returns data from the rest', async () => {
    mockGetCatalog.mockImplementation(async ({providerValue}) => {
      if (providerValue === 'broken') {
        throw new Error('site is down');
      }
      return [{title: 'Popular', filter: 'popular'}];
    });
    mockGetPosts.mockResolvedValue([
      {title: 'Working Movie', link: '/w/1', image: ''},
    ]);

    const result = await getHomePageData(
      [{value: 'broken'}, {value: 'working'}],
      new AbortController().signal,
    );

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].Posts.map(p => p.title)).toEqual([
      'Working Movie',
    ]);
  });

  it('throws when no provider returns any content', async () => {
    mockGetCatalog.mockResolvedValue([]);
    mockGetPosts.mockResolvedValue([]);

    await expect(
      getHomePageData([{value: 'alpha'}], new AbortController().signal),
    ).rejects.toThrow('Failed to load any content from installed providers');
  });

  it('does not let one hung provider block results from the rest beyond its own timeout, and reports it as stale', async () => {
    jest.useFakeTimers();
    try {
      mockGetCatalog.mockImplementation(async ({providerValue}) => {
        if (providerValue === 'hung') {
          return new Promise(() => {}); // never resolves - simulates a dead provider
        }
        return [{title: 'Popular', filter: 'popular'}];
      });
      mockGetPosts.mockResolvedValue([
        {title: 'Fast Movie', link: '/f/1', image: ''},
      ]);

      const resultPromise = getHomePageData(
        [{value: 'hung'}, {value: 'fast'}],
        new AbortController().signal,
      );

      // Advance past the per-provider timeout without waiting 8 real seconds.
      await jest.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;

      expect(result.sections[0].Posts.map(p => p.title)).toEqual([
        'Fast Movie',
      ]);
      expect(result.staleProviderValues).toEqual(['hung']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to a provider\'s last cached posts when it times out, instead of dropping it', async () => {
    // First run: "flaky" succeeds and gets cached.
    mockGetCatalog.mockResolvedValue([{title: 'Popular', filter: 'popular'}]);
    mockGetPosts.mockImplementation(async ({providerValue}) => [
      {title: `${providerValue} Movie`, link: `/${providerValue}/1`, image: ''},
    ]);

    const firstRun = await getHomePageData(
      [{value: 'flaky'}],
      new AbortController().signal,
    );
    expect(firstRun.sections[0].Posts.map(p => p.title)).toEqual([
      'flaky Movie',
    ]);

    // Second run: "flaky" now hangs. It should still contribute its
    // previously cached post instead of vanishing from Home.
    jest.useFakeTimers();
    try {
      mockGetCatalog.mockImplementation(() => new Promise(() => {}));

      const secondRunPromise = getHomePageData(
        [{value: 'flaky'}],
        new AbortController().signal,
      );
      await jest.advanceTimersByTimeAsync(8_000);
      const secondRun = await secondRunPromise;

      expect(secondRun.sections[0].Posts.map(p => p.title)).toEqual([
        'flaky Movie',
      ]);
      expect(secondRun.staleProviderValues).toEqual(['flaky']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('retryStaleProviders', () => {
  beforeEach(() => {
    mockGetCatalog.mockReset();
    mockGetPosts.mockReset();
    mockCacheStore.clear();
  });

  it('returns false without calling anything when there is nothing stale', async () => {
    const improved = await retryStaleProviders([], new AbortController().signal);

    expect(improved).toBe(false);
    expect(mockGetCatalog).not.toHaveBeenCalled();
  });

  it('returns true when a previously stale provider succeeds on retry', async () => {
    mockGetCatalog.mockResolvedValue([{title: 'Popular', filter: 'popular'}]);
    mockGetPosts.mockResolvedValue([
      {title: 'Recovered Movie', link: '/r/1', image: ''},
    ]);

    const improved = await retryStaleProviders(
      ['recovered'],
      new AbortController().signal,
    );

    expect(improved).toBe(true);
  });

  it('returns false when the retry times out again', async () => {
    jest.useFakeTimers();
    try {
      mockGetCatalog.mockImplementation(() => new Promise(() => {}));

      const improvedPromise = retryStaleProviders(
        ['still-down'],
        new AbortController().signal,
      );
      await jest.advanceTimersByTimeAsync(8_000);

      expect(await improvedPromise).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
