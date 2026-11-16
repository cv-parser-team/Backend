import { fuzzyMatch } from './normalization.fuzzy.js';
import { canonicalCategory, canonicalStatus } from './normalization.table.js';

export type CanonicalCategory = (typeof canonicalCategory.enumValues)[number];

export interface DictionaryTerm {
  termId: string;
  category: CanonicalCategory;
  canonicalName: string;
  status: (typeof canonicalStatus.enumValues)[number];
  mergedIntoId: string | null;
}

// One spelling of a term in a category: its canonical name or an approved,
// global alias.
export interface DictionaryEntry {
  matchKey: string;
  term: DictionaryTerm;
}

// The dictionary lookups that matching needs. Only global, approved aliases
// are used.
export interface DictionaryLookup {
  findTermByMatchKey(category: CanonicalCategory, matchKey: string): Promise<DictionaryTerm | null>;
  findTermsByApprovedAlias(
    category: CanonicalCategory,
    matchKey: string
  ): Promise<DictionaryTerm[]>;
  findTermById(termId: string): Promise<DictionaryTerm | null>;
  // Every canonical name and approved global alias of the category, for
  // spelling-tolerant matching.
  listDictionaryEntries(category: CanonicalCategory): Promise<DictionaryEntry[]>;
}

export type MatchResult =
  | {
      status: 'matched';
      method: 'canonical' | 'alias' | 'fuzzy';
      term: DictionaryTerm;
      // 1 for exact matches; below 1 for a spelling correction.
      confidence: number;
    }
  | { status: 'ambiguous'; method: 'alias' | 'fuzzy'; terms: DictionaryTerm[] }
  | { status: 'unmatched' };

// The rule version stored with each decision, so decisions made by different
// matching rules can be told apart.
export const MATCHING_RULE_VERSION = 'fuzzy-v1';

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

// Corrects spelling against every canonical name and approved alias of the
// category. Entries of merged terms count as the term they were merged into.
async function matchSpelling(
  lookup: DictionaryLookup,
  category: CanonicalCategory,
  matchKey: string
): Promise<MatchResult> {
  const entries = await lookup.listDictionaryEntries(category);
  const activeById = new Map<string, DictionaryTerm | null>();
  const candidates: { matchKey: string; item: DictionaryTerm }[] = [];

  for (const entry of entries) {
    if (!activeById.has(entry.term.termId)) {
      activeById.set(entry.term.termId, await activeTerm(lookup, entry.term));
    }
    const active = activeById.get(entry.term.termId);
    if (active) {
      candidates.push({ matchKey: entry.matchKey, item: active });
    }
  }

  const result = fuzzyMatch(matchKey, candidates, (item) => item.termId);
  switch (result.status) {
    case 'matched':
      return {
        status: 'matched',
        method: 'fuzzy',
        term: result.item,
        confidence: result.confidence
      };
    case 'ambiguous':
      return { status: 'ambiguous', method: 'fuzzy', terms: result.items };
    case 'unmatched':
      return { status: 'unmatched' };
  }
}

// Matches a value against canonical terms first, then approved aliases, then
// spelling corrections of either, and stops at the first match. A value that
// leads to more than one term is ambiguous and is not guessed.
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
  return matchSpelling(lookup, category, matchKey);
}
