import {
  getHomePageData,
  retryStaleProviders,
  getCategoryCatalog,
  getHomePageDataForCategory,
  HOME_SECTION_TITLES,
} from '../src/lib/getHomepagedata';

const mockGetCatalog = jest.fn();
const mockGetPosts = jest.fn();
const mockGetGenres = jest.fn();

jest.mock('../src/lib/services/ProviderManager', () => ({
  providerManager: {
    getCatalog: (...args: unknown[]) => mockGetCatalog(...args),
    getPosts: (...args: unknown[]) => mockGetPosts(...args),
    getGenres: (...args: unknown[]) => mockGetGenres(...args),
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

describe('getCategoryCatalog', () => {
  beforeEach(() => {
    mockGetCatalog.mockReset();
    mockGetGenres.mockReset();
    mockCacheStore.clear();
  });

  it('adds a Movies chip when at least one provider has a movies catalog entry', async () => {
    mockGetCatalog.mockImplementation(async ({providerValue}) =>
      providerValue === 'alpha'
        ? [{title: 'Movies', filter: 'movies'}]
        : [{title: 'Popular', filter: 'popular'}],
    );
    mockGetGenres.mockResolvedValue([]);

    const {options, filtersByCategory} = await getCategoryCatalog(
      [{value: 'alpha'}, {value: 'beta'}],
      new AbortController().signal,
    );

    expect(options).toContainEqual({id: '__movies', label: 'Movies'});
    expect(filtersByCategory.get('__movies')).toEqual([
      {providerValue: 'alpha', filter: 'movies'},
    ]);
  });

  it('adds a TV Shows chip when a provider catalog or genre title matches show keywords', async () => {
    mockGetCatalog.mockResolvedValue([]);
    mockGetGenres.mockImplementation(async ({providerValue}) =>
      providerValue === 'alpha'
        ? [{title: 'TV Shows', filter: 'tv-shows'}]
        : [],
    );

    const {options} = await getCategoryCatalog(
      [{value: 'alpha'}, {value: 'beta'}],
      new AbortController().signal,
    );

    expect(options).toContainEqual({id: '__tv_shows', label: 'TV Shows'});
  });

  it('only turns a genre into a chip once at least 2 providers share it', async () => {
    mockGetCatalog.mockResolvedValue([]);
    mockGetGenres.mockImplementation(async ({providerValue}) => {
      if (providerValue === 'alpha' || providerValue === 'beta') {
        return [{title: 'Action', filter: 'action'}];
      }
      return [{title: 'Solo Genre', filter: 'solo'}];
    });

    const {options, filtersByCategory} = await getCategoryCatalog(
      [{value: 'alpha'}, {value: 'beta'}, {value: 'gamma'}],
      new AbortController().signal,
    );

    expect(options.some(o => o.label === 'Action')).toBe(true);
    expect(options.some(o => o.label === 'Solo Genre')).toBe(false);
    const actionOption = options.find(o => o.label === 'Action')!;
    expect(filtersByCategory.get(actionOption.id)).toEqual([
      {providerValue: 'alpha', filter: 'action'},
      {providerValue: 'beta', filter: 'action'},
    ]);
  });

  it('treats a provider that fails to load catalog/genres as contributing nothing', async () => {
    mockGetCatalog.mockImplementation(async ({providerValue}) => {
      if (providerValue === 'broken') {
        throw new Error('down');
      }
      return [{title: 'Movies', filter: 'movies'}];
    });
    mockGetGenres.mockResolvedValue([]);

    const {options} = await getCategoryCatalog(
      [{value: 'broken'}, {value: 'working'}],
      new AbortController().signal,
    );

    expect(options).toContainEqual({id: '__movies', label: 'Movies'});
  });

  it('does not let a hung provider block category discovery beyond its timeout', async () => {
    jest.useFakeTimers();
    try {
      mockGetCatalog.mockImplementation(async ({providerValue}) => {
        if (providerValue === 'hung') {
          return new Promise(() => {});
        }
        return [{title: 'Movies', filter: 'movies'}];
      });
      mockGetGenres.mockResolvedValue([]);

      const resultPromise = getCategoryCatalog(
        [{value: 'hung'}, {value: 'fast'}],
        new AbortController().signal,
      );
      await jest.advanceTimersByTimeAsync(8_000);
      const {options} = await resultPromise;

      expect(options).toContainEqual({id: '__movies', label: 'Movies'});
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('getHomePageDataForCategory', () => {
  beforeEach(() => {
    mockGetPosts.mockReset();
  });

  it('merges posts for one category across every provider that has it', async () => {
    mockGetPosts.mockImplementation(async ({providerValue}) => [
      {title: `${providerValue} Movie`, link: `/${providerValue}/1`, image: ''},
    ]);

    const result = await getHomePageDataForCategory(
      {id: '__movies', label: 'Movies'},
      [
        {providerValue: 'alpha', filter: 'movies'},
        {providerValue: 'beta', filter: 'films'},
      ],
      new AbortController().signal,
    );

    expect(result.title).toBe('Movies');
    expect(result.filter).toBe('__movies');
    expect(result.Posts.map(p => p.title)).toEqual([
      'alpha Movie',
      'beta Movie',
    ]);
  });

  it('drops a provider whose fetch fails and still returns the rest', async () => {
    mockGetPosts.mockImplementation(async ({providerValue}) => {
      if (providerValue === 'broken') {
        throw new Error('down');
      }
      return [{title: 'Working Movie', link: '/w/1', image: ''}];
    });

    const result = await getHomePageDataForCategory(
      {id: '__movies', label: 'Movies'},
      [
        {providerValue: 'broken', filter: 'movies'},
        {providerValue: 'working', filter: 'movies'},
      ],
      new AbortController().signal,
    );

    expect(result.Posts.map(p => p.title)).toEqual(['Working Movie']);
  });

  it('does not let a hung provider block the rest beyond its timeout', async () => {
    jest.useFakeTimers();
    try {
      mockGetPosts.mockImplementation(async ({providerValue}) => {
        if (providerValue === 'hung') {
          return new Promise(() => {});
        }
        return [{title: 'Fast Movie', link: '/f/1', image: ''}];
      });

      const resultPromise = getHomePageDataForCategory(
        {id: '__movies', label: 'Movies'},
        [
          {providerValue: 'hung', filter: 'movies'},
          {providerValue: 'fast', filter: 'movies'},
        ],
        new AbortController().signal,
      );
      await jest.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;

      expect(result.Posts.map(p => p.title)).toEqual(['Fast Movie']);
    } finally {
      jest.useRealTimers();
    }
  });
});
