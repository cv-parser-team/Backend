import { allowedEdits, editDistance } from '../normalization/normalization.fuzzy.js';

// How closely two names written on CVs, such as an employer or an institution,
// look like the same entity. The names of these entities are not normalized
// to canonical terms, so claims from different CVs often spell them
// differently.
//
// - same: the names differ only in case, punctuation, connecting words, a
//   legal suffix, or a common abbreviation ("Northstar Labs, Inc." and
//   "Northstar Labs").
// - similar: the names may be the same entity but the candidate must confirm
//   it: reordered words, a typo, initials, or a shortened word ("University of
//   Jordan" and "Jordan University", "MIT" and "Massachusetts Institute of
//   Technology").
// - different: anything else, including a name that only shares some words
//   with the other ("Jordan University" and "Jordan University of Science and
//   Technology").
export type NameSimilarity = 'same' | 'similar' | 'different';

// Words that join the parts of a name and carry no identity.
const CONNECTING_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'the']);

// Legal forms that companies may write or omit.
const LEGAL_SUFFIXES = new Set([
  'ag',
  'co',
  'company',
  'corp',
  'corporation',
  'gmbh',
  'inc',
  'incorporated',
  'limited',
  'llc',
  'llp',
  'ltd',
  'plc'
]);

// Abbreviations with one common meaning in CVs. Ambiguous ones, such as "eng"
// (engineer, engineering, English) or "dev" (developer, development), are left
// to the shortened-word rule, which only suggests a match.
const ABBREVIATIONS: Record<string, string> = {
  asst: 'assistant',
  dept: 'department',
  govt: 'government',
  intl: 'international',
  jr: 'junior',
  mgmt: 'management',
  mgr: 'manager',
  natl: 'national',
  snr: 'senior',
  sr: 'senior'
};

// A shortened word must keep at least this many letters ("Comp" for
// "Computer"); shorter prefixes match too many words.
const MINIMUM_SHORTENED_WORD_LENGTH = 3;

function isIgnorable(word: string): boolean {
  return CONNECTING_WORDS.has(word) || LEGAL_SUFFIXES.has(word);
}

// Splits a name into lowercase words without accents or punctuation.
// Apostrophes are removed so "King's" stays one word.
function words(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/['’`]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => ABBREVIATIONS[word] ?? word);
}

// The words that identify the entity. A name made only of ignorable words
// keeps them, so it is not compared as empty.
function identifyingWords(all: string[]): string[] {
  const identifying = all.filter((word) => !isIgnorable(word));
  return identifying.length > 0 ? identifying : all;
}

function isWordTypo(left: string, right: string): boolean {
  if (left === right || left === `${right}s` || right === `${left}s`) {
    return true;
  }
  // Different numbers name different things ("Branch 12" and "Branch 13").
  if (/\d/u.test(left) || /\d/u.test(right)) {
    return false;
  }
  const limit = allowedEdits(Math.max([...left].length, [...right].length));
  return limit > 0 && editDistance(left, right, limit) <= limit;
}

// Typos are counted per word, so a long name cannot hide a changed word:
// "Northstar" and "Southstar" are two edits apart, more than one word allows.
function isTypo(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((word, index) => isWordTypo(word, right[index]!))
  );
}

function initials(run: string[]): string {
  return run.map((word) => word[0]).join('');
}

// Whether every word of `short` stands for consecutive words of `full`: the
// same word, a shortened form of it ("comp" for "computer"), or the initials
// of two or more words ("uc" for "university of california"). Ignorable words
// may be skipped on either side, but every identifying word of `full` must be
// covered, so a name that only shares some words does not match.
function abbreviates(short: string[], full: string[]): boolean {
  const memo = new Map<string, boolean>();

  const match = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const known = memo.get(key);
    if (known !== undefined) {
      return known;
    }

    let result = false;
    if (i === short.length) {
      result = full.slice(j).every(isIgnorable);
    } else if (j === full.length) {
      result = short.slice(i).every(isIgnorable);
    } else {
      const word = short[i]!;
      const target = full[j]!;
      result =
        (isIgnorable(target) && match(i, j + 1)) ||
        (isIgnorable(word) && match(i + 1, j)) ||
        (word === target && match(i + 1, j + 1)) ||
        (word.length >= MINIMUM_SHORTENED_WORD_LENGTH &&
          word.length < target.length &&
          target.startsWith(word) &&
          match(i + 1, j + 1));

      for (let end = j + 2; !result && end <= full.length; end += 1) {
        const run = full.slice(j, end);
        if (isIgnorable(run[0]!)) {
          break;
        }
        const withoutIgnorable = run.filter((runWord) => !isIgnorable(runWord));
        if (
          (word === initials(run) || word === initials(withoutIgnorable)) &&
          match(i + 1, end)
        ) {
          result = true;
        }
      }
    }

    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

export function compareNames(left: string, right: string): NameSimilarity {
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.length === 0 || rightWords.length === 0) {
    return 'different';
  }

  const leftIdentity = identifyingWords(leftWords);
  const rightIdentity = identifyingWords(rightWords);
  const leftJoined = leftIdentity.join('');
  const rightJoined = rightIdentity.join('');
  // Joining the words also treats "Data Soft" and "DataSoft" as the same.
  if (leftJoined === rightJoined) {
    return 'same';
  }

  const sortedLeft = [...leftIdentity].sort().join(' ');
  const sortedRight = [...rightIdentity].sort().join(' ');
  if (sortedLeft === sortedRight) {
    return 'similar';
  }

  if (isTypo(leftIdentity, rightIdentity)) {
    return 'similar';
  }

  // The abbreviated name is the shorter one; trying both directions keeps the
  // result independent of argument order.
  return abbreviates(leftWords, rightWords) || abbreviates(rightWords, leftWords)
    ? 'similar'
    : 'different';
}
