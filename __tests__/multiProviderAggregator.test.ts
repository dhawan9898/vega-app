import {
  mergePostsRoundRobin,
  raceForFirstValid,
  resolveFastestCandidate,
} from '../src/lib/services/MultiProviderAggregator';

const mockGetMetaData = jest.fn();

jest.mock('../src/lib/services/ProviderManager', () => ({
  providerManager: {
    getMetaData: (...args: unknown[]) => mockGetMetaData(...args),
  },
}));

describe('mergePostsRoundRobin', () => {
  it('interleaves posts round-robin across providers instead of grouping by provider', () => {
    const merged = mergePostsRoundRobin([
      {
        providerValue: 'alpha',
        posts: [
          {title: 'Alpha One', link: '/a/1', image: ''},
          {title: 'Alpha Two', link: '/a/2', image: ''},
        ],
      },
      {
        providerValue: 'beta',
        posts: [{title: 'Beta One', link: '/b/1', image: ''}],
      },
    ]);

    expect(merged.map(post => post.title)).toEqual([
      'Alpha One',
      'Beta One',
      'Alpha Two',
    ]);
  });

  it('dedupes posts with the same normalized title across providers and keeps every provider as a candidate', () => {
    const merged = mergePostsRoundRobin([
      {
        providerValue: 'alpha',
        posts: [{title: 'The Matrix (1999)', link: '/a/matrix', image: 'a.jpg'}],
      },
      {
        providerValue: 'beta',
        posts: [{title: 'the matrix   1999', link: '/b/matrix', image: 'b.jpg'}],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].candidates).toEqual([
      {provider: 'alpha', link: '/a/matrix'},
      {provider: 'beta', link: '/b/matrix'},
    ]);
    // Representative post keeps the first-seen provider's title/image.
    expect(merged[0].title).toBe('The Matrix (1999)');
  });

  it('skips posts with no title or link', () => {
    const merged = mergePostsRoundRobin([
      {
        providerValue: 'alpha',
        posts: [
          {title: '', link: '/a/1', image: ''},
          {title: 'Valid', link: '', image: ''},
          {title: 'Valid Two', link: '/a/2', image: ''},
        ],
      },
    ]);

    expect(merged.map(post => post.title)).toEqual(['Valid Two']);
  });

  it('stops once the limit is reached', () => {
    const posts = Array.from({length: 10}).map((_, i) => ({
      title: `Title ${i}`,
      link: `/a/${i}`,
      image: '',
    }));
    const merged = mergePostsRoundRobin(
      [{providerValue: 'alpha', posts}],
      3,
    );

    expect(merged).toHaveLength(3);
  });
});

describe('raceForFirstValid', () => {
  it('returns the first result that passes validity, ignoring slower or invalid ones', async () => {
    const result = await raceForFirstValid(
      ['slow', 'invalid', 'fast'],
      async item => {
        if (item === 'slow') {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 'slow-result';
        }
        if (item === 'invalid') {
          return null;
        }
        return 'fast-result';
      },
      value => value !== null,
    );

    expect(result).toEqual({item: 'fast', result: 'fast-result'});
  });

  it('resolves to null when every candidate fails or is invalid', async () => {
    const result = await raceForFirstValid(
      ['a', 'b'],
      async item => {
        if (item === 'a') {
          throw new Error('boom');
        }
        return null;
      },
      value => value !== null,
    );

    expect(result).toBeNull();
  });

  it('resolves to null immediately for an empty candidate list', async () => {
    const result = await raceForFirstValid([], async () => 'x', () => true);
    expect(result).toBeNull();
  });
});

describe('resolveFastestCandidate', () => {
  beforeEach(() => {
    mockGetMetaData.mockReset();
  });

  it('returns metadata from whichever provider responds first with usable data', async () => {
    mockGetMetaData.mockImplementation(async ({provider}: {provider: string}) => {
      if (provider === 'slowProvider') {
        await new Promise(resolve => setTimeout(resolve, 50));
        return {title: 'Slow', image: '', synopsis: '', type: 'movie', linkList: []};
      }
      return {title: 'Fast', image: '', synopsis: '', type: 'movie', linkList: []};
    });

    const result = await resolveFastestCandidate([
      {provider: 'slowProvider', link: '/slow'},
      {provider: 'fastProvider', link: '/fast'},
    ]);

    expect(result?.provider).toBe('fastProvider');
    expect(result?.meta.title).toBe('Fast');
  });

  it('falls back to the next candidate when the fastest one returns unusable data', async () => {
    mockGetMetaData.mockImplementation(async ({provider}: {provider: string}) => {
      if (provider === 'empty') {
        return {title: '', image: '', synopsis: '', type: '', linkList: []};
      }
      return {title: 'Good', image: '', synopsis: '', type: 'movie', linkList: []};
    });

    const result = await resolveFastestCandidate([
      {provider: 'empty', link: '/empty'},
      {provider: 'good', link: '/good'},
    ]);

    expect(result?.provider).toBe('good');
  });

  it('returns null when every candidate fails', async () => {
    mockGetMetaData.mockRejectedValue(new Error('down'));

    const result = await resolveFastestCandidate([
      {provider: 'a', link: '/a'},
      {provider: 'b', link: '/b'},
    ]);

    expect(result).toBeNull();
  });
});
