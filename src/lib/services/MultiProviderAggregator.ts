import {Info, Post} from '../providers/types';
import {providerManager} from './ProviderManager';

export interface CandidateRef {
  provider: string;
  link: string;
}

export type MergedPost = Post & {candidates: CandidateRef[]};

/**
 * Collapses a title down to a comparable key so the same movie/show scraped
 * by different providers (different punctuation, casing, whitespace) merges
 * into a single card instead of showing once per provider.
 */
export const normalizeTitle = (title: string): string =>
  (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Interleaves each provider's post list round-robin (rather than
 * concatenating provider-by-provider) so no single provider dominates the
 * merged list, then dedupes by normalized title. Every provider that
 * returned a matching title is kept as a candidate for later, so playback
 * can race between them instead of the user picking a provider up front.
 */
export function mergePostsRoundRobin(
  perProvider: {providerValue: string; posts: Post[]}[],
  limit?: number,
): MergedPost[] {
  const merged: MergedPost[] = [];
  const byKey = new Map<string, MergedPost>();

  const maxLength = perProvider.reduce(
    (max, entry) => Math.max(max, entry.posts.length),
    0,
  );

  for (let i = 0; i < maxLength; i += 1) {
    for (const {providerValue, posts} of perProvider) {
      const post = posts[i];
      if (!post || !post.link) {
        continue;
      }
      const key = normalizeTitle(post.title);
      if (!key) {
        continue;
      }
      const candidate: CandidateRef = {
        provider: post.provider || providerValue,
        link: post.link,
      };

      const existing = byKey.get(key);
      if (existing) {
        if (
          !existing.candidates.some(
            c => c.provider === candidate.provider && c.link === candidate.link,
          )
        ) {
          existing.candidates.push(candidate);
        }
        continue;
      }

      const mergedPost: MergedPost = {
        ...post,
        provider: candidate.provider,
        candidates: [candidate],
      };
      byKey.set(key, mergedPost);
      merged.push(mergedPost);
      if (limit && merged.length >= limit) {
        return merged;
      }
    }
  }

  return merged;
}

/**
 * Calls `resolver` for every candidate concurrently and returns the first
 * one whose result passes `isValid` - so the app can fetch from whichever
 * provider answers first instead of asking the user to pick one. Slower or
 * failing candidates are simply ignored; if every candidate fails or times
 * out this resolves to null.
 */
export function raceForFirstValid<T, R>(
  items: T[],
  resolver: (item: T) => Promise<R>,
  isValid: (result: R) => boolean,
  timeoutMs = 15000,
): Promise<{item: T; result: R} | null> {
  if (items.length === 0) {
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    let settledCount = 0;
    let finished = false;

    const finish = (value: {item: T; result: R} | null) => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(value);
    };

    items.forEach(item => {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider timed out')),
          timeoutMs,
        );
      });

      Promise.race([resolver(item), timeout])
        .then(result => {
          clearTimeout(timer);
          settledCount += 1;
          if (!finished && isValid(result)) {
            finish({item, result});
          } else if (settledCount === items.length) {
            finish(null);
          }
        })
        .catch(() => {
          clearTimeout(timer);
          settledCount += 1;
          if (settledCount === items.length) {
            finish(null);
          }
        });
    });
  });
}

const dedupeCandidates = (candidates: CandidateRef[]): CandidateRef[] => {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.provider}:${candidate.link}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * Races metadata fetches across every provider known to carry this title
 * and returns whichever one comes back first with usable data. This is
 * the "automatically use the faster provider" step: the caller never has
 * to show a provider picker, it just gets back the winning provider+link.
 */
export async function resolveFastestCandidate(
  candidates: CandidateRef[],
  timeoutMs = 15000,
): Promise<{provider: string; link: string; meta: Info} | null> {
  const unique = dedupeCandidates(candidates);
  const winner = await raceForFirstValid<CandidateRef, Info>(
    unique,
    candidate =>
      providerManager.getMetaData({
        link: candidate.link,
        provider: candidate.provider,
      }),
    meta => Boolean(meta && (meta.title || meta.synopsis || meta.image)),
    timeoutMs,
  );

  if (!winner) {
    return null;
  }
  return {
    provider: winner.item.provider,
    link: winner.item.link,
    meta: winner.result,
  };
}
