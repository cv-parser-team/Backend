import { canonicalCategory, canonicalStatus } from './normalization.table.js';

export type CanonicalCategory = (typeof canonicalCategory.enumValues)[number];

export interface DictionaryTerm {
  termId: string;
  category: CanonicalCategory;
  canonicalName: string;
  status: (typeof canonicalStatus.enumValues)[number];
  mergedIntoId: string | null;
}

// The dictionary lookups that matching needs. Only global, approved aliases
// are used in V1.
export interface DictionaryLookup {
  findTermByMatchKey(category: CanonicalCategory, matchKey: string): Promise<DictionaryTerm | null>;
  findTermsByApprovedAlias(
    category: CanonicalCategory,
    matchKey: string
  ): Promise<DictionaryTerm[]>;
  findTermById(termId: string): Promise<DictionaryTerm | null>;
}

export type MatchResult =
  | {
      status: 'matched';
      method: 'canonical' | 'alias';
      term: DictionaryTerm;
      // Exact matches are certain.
      confidence: 1;
    }
  | { status: 'ambiguous'; method: 'alias'; terms: DictionaryTerm[] }
  | { status: 'unmatched' };

// The rule version stored with each decision, so decisions made by different
// matching rules can be told apart.
export const MATCHING_RULE_VERSION = 'exact-v1';

// Compares values case- and space-insensitively. Punctuation is kept, because
// it carries meaning in values such as "C", "C#", and "C++".
export function toMatchKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// A merged term is followed to the active term it was merged into. A broken or
// circular chain finds no term.
async function activeTerm(
  lookup: DictionaryLookup,
  term: DictionaryTerm | null
): Promise<DictionaryTerm | null> {
  const seen = new Set<string>();
  let current = term;
  while (current && current.status === 'merged') {
    if (seen.has(current.termId) || !current.mergedIntoId) {
      return null;
    }
    seen.add(current.termId);
    current = await lookup.findTermById(current.mergedIntoId);
  }
  return current;
}

// Matches a value against canonical terms first, then approved aliases, and
// stops at the first match. Aliases that lead to more than one term are
// ambiguous and are left for the candidate to resolve.
export async function matchTerm(
  lookup: DictionaryLookup,
  category: CanonicalCategory,
  value: string
): Promise<MatchResult> {
  const matchKey = toMatchKey(value);
  if (!matchKey) {
    return { status: 'unmatched' };
  }

  const canonical = await activeTerm(lookup, await lookup.findTermByMatchKey(category, matchKey));
  if (canonical) {
    return { status: 'matched', method: 'canonical', term: canonical, confidence: 1 };
  }

  const aliasTerms = await lookup.findTermsByApprovedAlias(category, matchKey);
  const resolved = new Map<string, DictionaryTerm>();
  for (const term of aliasTerms) {
    const active = await activeTerm(lookup, term);
    if (active) {
      resolved.set(active.termId, active);
    }
  }

  const terms = [...resolved.values()];
  if (terms.length === 1) {
    return { status: 'matched', method: 'alias', term: terms[0]!, confidence: 1 };
  }
  if (terms.length > 1) {
    return { status: 'ambiguous', method: 'alias', terms };
  }
  return { status: 'unmatched' };
}
