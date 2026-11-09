import { CanonicalCategory, toMatchKey } from './normalization.matching.js';
import { SEED_DICTIONARY, SeedTerm } from './normalization.seed-data.js';

// Adds a row only when it is missing, and reports whether it was added.
export interface DictionaryWriter {
  ensureTerm(
    category: CanonicalCategory,
    canonicalName: string,
    matchKey: string
  ): Promise<{ termId: string; created: boolean }>;
  ensureAlias(termId: string, aliasText: string, matchKey: string): Promise<boolean>;
}

export interface SeedSummary {
  termsAdded: number;
  aliasesAdded: number;
}

// Loads the dictionary as active terms with approved, global seed aliases.
// Rows that already exist are left as they are, so it can run again safely.
export async function seedDictionary(
  writer: DictionaryWriter,
  dictionary: Record<CanonicalCategory, SeedTerm[]> = SEED_DICTIONARY
): Promise<SeedSummary> {
  const summary: SeedSummary = { termsAdded: 0, aliasesAdded: 0 };

  const categories = Object.entries(dictionary) as [CanonicalCategory, SeedTerm[]][];
  for (const [category, terms] of categories) {
    for (const term of terms) {
      const { termId, created } = await writer.ensureTerm(
        category,
        term.name,
        toMatchKey(term.name)
      );
      summary.termsAdded += created ? 1 : 0;
      for (const alias of term.aliases) {
        const added = await writer.ensureAlias(termId, alias, toMatchKey(alias));
        summary.aliasesAdded += added ? 1 : 0;
      }
    }
  }

  return summary;
}
