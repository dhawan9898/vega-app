import {getHomePageData, HOME_SECTION_TITLES} from '../src/lib/getHomepagedata';

const mockGetCatalog = jest.fn();
const mockGetPosts = jest.fn();

jest.mock('../src/lib/services/ProviderManager', () => ({
  providerManager: {
    getCatalog: (...args: unknown[]) => mockGetCatalog(...args),
    getPosts: (...args: unknown[]) => mockGetPosts(...args),
  },
}));

describe('getHomePageData', () => {
  beforeEach(() => {
    mockGetCatalog.mockReset();
    mockGetPosts.mockReset();
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

    const data = await getHomePageData(
      [{value: 'alpha'}, {value: 'beta'}],
      new AbortController().signal,
    );

    expect(data).toHaveLength(1);
    expect(data[0].title).toBe(HOME_SECTION_TITLES[0]);
    expect(data[0].Posts.map(p => p.title)).toEqual([
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

    const data = await getHomePageData(
      [{value: 'broken'}, {value: 'working'}],
      new AbortController().signal,
    );

    expect(data).toHaveLength(1);
    expect(data[0].Posts.map(p => p.title)).toEqual(['Working Movie']);
  });

  it('throws when no provider returns any content', async () => {
    mockGetCatalog.mockResolvedValue([]);
    mockGetPosts.mockResolvedValue([]);

    await expect(
      getHomePageData([{value: 'alpha'}], new AbortController().signal),
    ).rejects.toThrow('Failed to load any content from installed providers');
  });

  it('does not let one hung provider block results from the rest beyond its own timeout', async () => {
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
      const data = await resultPromise;

      expect(data[0].Posts.map(p => p.title)).toEqual(['Fast Movie']);
    } finally {
      jest.useRealTimers();
    }
  });
});
