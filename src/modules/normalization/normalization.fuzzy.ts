// Spelling-tolerant matching of match keys, used after exact matching fails.
// It only corrects typing mistakes; different names are left to the AI step.

// Words shorter than this are compared exactly: one changed letter in a short
// word is usually a different word ("Java" and "Lava", "Swift" and "Shift").
export const FUZZY_MINIMUM_LENGTH = 6;

// The number of edits accepted grows with the length of the value, so a long
// value may contain a few typos while a short one may contain at most one.
export function allowedEdits(length: number): number {
  if (length < FUZZY_MINIMUM_LENGTH) {
    return 0;
  }
  if (length < 10) {
    return 1;
  }
  if (length < 16) {
    return 2;
  }
  return 3;
}

// Optimal string alignment distance: insertions, deletions, substitutions,
// and swaps of two adjacent characters ("pyhton" for "python") each count as
// one edit. Returns `limit + 1` as soon as the distance must exceed `limit`.
export function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) {
    return limit + 1;
  }

  const a = [...left];
  const b = [...right];
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let distance = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        distance = Math.min(distance, beforePrevious[j - 2]! + 1);
      }
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > limit) {
      return limit + 1;
    }
    beforePrevious = previous;
    previous = current;
  }

  return Math.min(previous[b.length]!, limit + 1);
}

export interface FuzzyCandidate<T> {
  matchKey: string;
  item: T;
}

export type FuzzyResult<T> =
  | { status: 'matched'; item: T; distance: number; confidence: number }
  | { status: 'ambiguous'; items: T[] }
  | { status: 'unmatched' };

// A correction must be clearly closer than any other item: the next item must
// need at least this many more edits. The dictionary has real pairs one or two
// edits apart, such as "Next.js" and "NestJS" or "Project Manager" and
// "Product Manager", where a value between them is not a typo of either.
export const FUZZY_MINIMUM_MARGIN = 2;

interface ClosestSpelling<T> {
  item: T;
  distance: number;
  keyLength: number;
}

// Finds the item whose spelling is closest to the match key within the allowed
// edits. Spellings of the same item, such as a term and its alias, count once.
// When another item is nearly as close, the result is ambiguous rather than a
// guess.
export function fuzzyMatch<T>(
  matchKey: string,
  candidates: FuzzyCandidate<T>[],
  identify: (item: T) => string
): FuzzyResult<T> {
  const keyLength = [...matchKey].length;
  const limit = allowedEdits(keyLength);
  if (limit === 0) {
    return { status: 'unmatched' };
  }

  // Distances up to the margin beyond the limit are needed to tell whether a
  // match is clearly closer than the next item.
  const searchLimit = limit + FUZZY_MINIMUM_MARGIN - 1;
  const closestById = new Map<string, ClosestSpelling<T>>();

  for (const candidate of candidates) {
    const candidateLength = [...candidate.matchKey].length;
    if (candidateLength < FUZZY_MINIMUM_LENGTH) {
      continue;
    }
    const distance = editDistance(matchKey, candidate.matchKey, searchLimit);
    if (distance > searchLimit) {
      continue;
    }
    const id = identify(candidate.item);
    const known = closestById.get(id);
    if (!known || distance < known.distance) {
      closestById.set(id, { item: candidate.item, distance, keyLength: candidateLength });
    }
  }

  const ranked = [...closestById.values()].sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  if (!best || best.distance > limit) {
    return { status: 'unmatched' };
  }

  const contenders = ranked.filter(
    (spelling) => spelling.distance < best.distance + FUZZY_MINIMUM_MARGIN
  );
  if (contenders.length > 1) {
    // Closest first, so later steps can show the likeliest term first.
    return { status: 'ambiguous', items: contenders.map((spelling) => spelling.item) };
  }

  // The share of the longer value that did not need editing.
  const longest = Math.max(keyLength, best.keyLength);
  const confidence = Math.floor((1 - best.distance / longest) * 100) / 100;
  return { status: 'matched', item: best.item, distance: best.distance, confidence };
}
