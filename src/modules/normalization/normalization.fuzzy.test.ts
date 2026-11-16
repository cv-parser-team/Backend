import { describe, expect, it } from 'vitest';
import {
  allowedEdits,
  editDistance,
  FUZZY_MINIMUM_MARGIN,
  fuzzyMatch
} from './normalization.fuzzy.js';
import { toMatchKey } from './normalization.matching.js';
import { SEED_DICTIONARY } from './normalization.seed-data.js';

describe('edit distance', () => {
  it.each([
    ['python', 'python', 0],
    ['pyhton', 'python', 1],
    ['pythn', 'python', 1],
    ['pythonn', 'python', 1],
    ['pithon', 'python', 1],
    ['javascirpt', 'javascript', 1],
    ['jvaascript', 'javascript', 1],
    ['kitten', 'sitting', 3]
  ])('counts "%s" to "%s" as %i edits', (left, right, distance) => {
    expect(editDistance(left, right, 5)).toBe(distance);
  });

  it('stops counting beyond the limit', () => {
    expect(editDistance('javascript', 'typescript', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });
});

describe('allowed edits', () => {
  it.each([
    [3, 0],
    [5, 0],
    [6, 1],
    [9, 1],
    [10, 2],
    [15, 2],
    [16, 3],
    [40, 3]
  ])('allows a %i-character value %i edits', (length, edits) => {
    expect(allowedEdits(length)).toBe(edits);
  });
});

describe('fuzzy matching', () => {
  const spellings = (...keys: string[]) =>
    keys.map((matchKey) => ({ matchKey, item: matchKey }));
  const byName = (item: string) => item;

  it('corrects a typo to the only close spelling', () => {
    expect(fuzzyMatch('pyhton', spellings('python', 'java'), byName)).toEqual({
      status: 'matched',
      item: 'python',
      distance: 1,
      confidence: 0.83
    });
  });

  it('compares short values exactly', () => {
    expect(fuzzyMatch('jav', spellings('java'), byName)).toEqual({ status: 'unmatched' });
    expect(fuzzyMatch('shift', spellings('swift'), byName)).toEqual({ status: 'unmatched' });
  });

  it('ignores short spellings, so a long typo never becomes a short term', () => {
    expect(fuzzyMatch('golang', spellings('go'), byName)).toEqual({ status: 'unmatched' });
  });

  it('leaves a value with too many edits unmatched', () => {
    expect(fuzzyMatch('typescript', spellings('javascript'), byName)).toEqual({
      status: 'unmatched'
    });
  });

  it('counts the spellings of one item once', () => {
    const result = fuzzyMatch(
      'postgress',
      [
        { matchKey: 'postgresql', item: 'PostgreSQL' },
        { matchKey: 'postgres', item: 'PostgreSQL' }
      ],
      byName
    );

    expect(result).toMatchObject({ status: 'matched', item: 'PostgreSQL', distance: 1 });
  });

  it('is ambiguous when another item is nearly as close', () => {
    const result = fuzzyMatch(
      'prodject manager',
      spellings('project manager', 'product manager'),
      byName
    );

    expect(result).toEqual({
      status: 'ambiguous',
      items: ['project manager', 'product manager']
    });
  });

  it(`matches when the next item is ${FUZZY_MINIMUM_MARGIN} or more edits further`, () => {
    expect(
      fuzzyMatch('project managr', spellings('project manager', 'product manager'), byName)
    ).toMatchObject({ status: 'matched', item: 'project manager' });
  });
});

describe('fuzzy matching against the starting dictionary', () => {
  // Every spelling of every term in one category, as the repository lists them.
  function categorySpellings(category: keyof typeof SEED_DICTIONARY) {
    return SEED_DICTIONARY[category].flatMap((entry) =>
      [entry.name, ...entry.aliases].map((text) => ({
        matchKey: toMatchKey(text),
        item: entry.name
      }))
    );
  }

  it.each([
    ['skill', 'Pyhton', 'Python'],
    ['skill', 'Javascirpt', 'JavaScript'],
    ['skill', 'Typescrpit', 'TypeScript'],
    ['skill', 'Postgress', 'PostgreSQL'],
    ['job_title', 'Sofware Enginer', 'Software Engineer'],
    ['job_title', 'Backend Develper', 'Backend Developer'],
    ['degree', 'Bachelor of Sciense', 'Bachelor of Science'],
    // One edit from "ML Engineer" and three from "QA Engineer": clearly closer.
    ['job_title', 'ML Enginer', 'Machine Learning Engineer']
  ] as const)('corrects %s "%s" to "%s"', (category, value, expected) => {
    const result = fuzzyMatch(toMatchKey(value), categorySpellings(category), (item) => item);

    expect(result).toMatchObject({ status: 'matched', item: expected });
  });

  it.each([
    ['skill', 'Nex.js'],
    ['job_title', 'Prodject Manager']
  ] as const)('does not guess between close terms for %s "%s"', (category, value) => {
    const result = fuzzyMatch(toMatchKey(value), categorySpellings(category), (item) => item);

    expect(result.status).toBe('ambiguous');
  });
});
