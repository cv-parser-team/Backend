import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  CanonicalCategory,
  DictionaryEntry,
  DictionaryLookup,
  DictionaryTerm
} from './normalization.matching.js';
import { DictionaryWriter } from './normalization.seed.js';
import { aliases, canonicalTerms, normalizationDecisions } from './normalization.table.js';

export type NormalizationDecisionRecord = typeof normalizationDecisions.$inferSelect;
export type CreateNormalizationDecisionInput = Omit<
  typeof normalizationDecisions.$inferInsert,
  'normalizationId' | 'createdAt'
>;

export interface DecisionStore {
  saveDecision(
    input: CreateNormalizationDecisionInput,
    transaction?: DatabaseExecutor
  ): Promise<NormalizationDecisionRecord>;
  // The newest decision is the claim's current one.
  findLatestDecision(
    claimId: string,
    transaction?: DatabaseExecutor
  ): Promise<NormalizationDecisionRecord | null>;
  // The current decision of each claim that has one.
  listLatestDecisions(claimIds: string[]): Promise<NormalizationDecisionRecord[]>;
  // The terms with these IDs, in any order; unknown IDs are left out.
  listTermsByIds(termIds: string[]): Promise<DictionaryTerm[]>;
}

// The dictionary access that AI matching needs.
export interface AiDictionary {
  // Active terms of the category, which the AI may choose from.
  listActiveTerms(category: CanonicalCategory): Promise<DictionaryTerm[]>;
  // The term an earlier AI match proposed for this spelling, so the same value
  // is not sent to the AI again while its alias awaits review.
  findAiProposedTerm(
    category: CanonicalCategory,
    matchKey: string
  ): Promise<DictionaryTerm | null>;
  // Records the AI's match as a pending global alias for human review. It is
  // not used by exact matching until a reviewer approves it.
  proposeAiAlias(
    termId: string,
    aliasText: string,
    matchKey: string,
    transaction?: DatabaseExecutor
  ): Promise<void>;
}

export interface NormalizationRepository
  extends DictionaryLookup,
    DictionaryWriter,
    DecisionStore,
    AiDictionary {}

const termColumns = {
  termId: canonicalTerms.termId,
  category: canonicalTerms.category,
  canonicalName: canonicalTerms.canonicalName,
  status: canonicalTerms.status,
  mergedIntoId: canonicalTerms.mergedIntoId
};

export function createNormalizationRepository(database: AppDatabase): NormalizationRepository {
  return {
    async findTermByMatchKey(category, matchKey) {
      return withDbErrors('Canonical term', async () => {
        const [term] = await database.db
          .select(termColumns)
          .from(canonicalTerms)
          .where(and(eq(canonicalTerms.category, category), eq(canonicalTerms.matchKey, matchKey)))
          .limit(1);
        return term ?? null;
      });
    },

    async findTermsByApprovedAlias(category, matchKey) {
      return withDbErrors('Alias', async (): Promise<DictionaryTerm[]> => {
        return database.db
          .select(termColumns)
          .from(aliases)
          .innerJoin(canonicalTerms, eq(canonicalTerms.termId, aliases.termId))
          .where(
            and(
              eq(aliases.matchKey, matchKey),
              eq(aliases.status, 'approved'),
              eq(aliases.scope, 'global'),
              eq(canonicalTerms.category, category)
            )
          );
      });
    },

    async findTermById(termId) {
      return withDbErrors('Canonical term', async () => {
        const [term] = await database.db
          .select(termColumns)
          .from(canonicalTerms)
          .where(eq(canonicalTerms.termId, termId))
          .limit(1);
        return term ?? null;
      });
    },

    async listDictionaryEntries(category) {
      return withDbErrors('Canonical term', async (): Promise<DictionaryEntry[]> => {
        const [names, approvedAliases] = await Promise.all([
          database.db
            .select({ matchKey: canonicalTerms.matchKey, term: termColumns })
            .from(canonicalTerms)
            .where(eq(canonicalTerms.category, category)),
          database.db
            .select({ matchKey: aliases.matchKey, term: termColumns })
            .from(aliases)
            .innerJoin(canonicalTerms, eq(canonicalTerms.termId, aliases.termId))
            .where(
              and(
                eq(aliases.status, 'approved'),
                eq(aliases.scope, 'global'),
                eq(canonicalTerms.category, category)
              )
            )
        ]);
        return [...names, ...approvedAliases];
      });
    },

    async ensureTerm(category, canonicalName, matchKey) {
      return withDbErrors('Canonical term', async () => {
        const [inserted] = await database.db
          .insert(canonicalTerms)
          .values({ category, canonicalName, matchKey })
          .onConflictDoNothing()
          .returning({ termId: canonicalTerms.termId });
        if (inserted) {
          return { termId: inserted.termId, created: true };
        }
        const [existing] = await database.db
          .select({ termId: canonicalTerms.termId })
          .from(canonicalTerms)
          .where(and(eq(canonicalTerms.category, category), eq(canonicalTerms.matchKey, matchKey)))
          .limit(1);
        if (!existing) {
          throw new Error('Canonical term could not be read after a conflict');
        }
        return { termId: existing.termId, created: false };
      });
    },

    async ensureAlias(termId, aliasText, matchKey) {
      return withDbErrors('Alias', async () => {
        const inserted = await database.db
          .insert(aliases)
          .values({
            termId,
            aliasText,
            matchKey,
            scope: 'global',
            origin: 'seed',
            status: 'approved'
          })
          .onConflictDoNothing()
          .returning({ aliasId: aliases.aliasId });
        return inserted.length > 0;
      });
    },

    async listActiveTerms(category) {
      return withDbErrors('Canonical term', () =>
        database.db
          .select(termColumns)
          .from(canonicalTerms)
          .where(and(eq(canonicalTerms.category, category), eq(canonicalTerms.status, 'active')))
          .orderBy(asc(canonicalTerms.canonicalName))
      );
    },

    async findAiProposedTerm(category, matchKey) {
      return withDbErrors('Alias', async () => {
        const [term] = await database.db
          .select(termColumns)
          .from(aliases)
          .innerJoin(canonicalTerms, eq(canonicalTerms.termId, aliases.termId))
          .where(
            and(
              eq(aliases.matchKey, matchKey),
              eq(aliases.origin, 'ai'),
              eq(aliases.status, 'pending'),
              eq(aliases.scope, 'global'),
              eq(canonicalTerms.category, category)
            )
          )
          .limit(1);
        return term ?? null;
      });
    },

    async proposeAiAlias(termId, aliasText, matchKey, transaction = database.db) {
      await withDbErrors('Alias', () =>
        transaction
          .insert(aliases)
          .values({ termId, aliasText, matchKey, scope: 'global', origin: 'ai', status: 'pending' })
          .onConflictDoNothing()
      );
    },

    async saveDecision(input, transaction = database.db) {
      return withDbErrors('Normalization decision', async () => {
        const [decision] = await transaction
          .insert(normalizationDecisions)
          .values(input)
          .returning();
        if (!decision) {
          throw new Error('Normalization decision save did not return a record');
        }
        return decision;
      });
    },

    async findLatestDecision(claimId, transaction = database.db) {
      return withDbErrors('Normalization decision', async () => {
        const [decision] = await transaction
          .select()
          .from(normalizationDecisions)
          .where(eq(normalizationDecisions.claimId, claimId))
          .orderBy(desc(normalizationDecisions.createdAt))
          .limit(1);
        return decision ?? null;
      });
    },

    async listLatestDecisions(claimIds) {
      if (claimIds.length === 0) {
        return [];
      }
      return withDbErrors('Normalization decision', async () =>
        database.db
          .selectDistinctOn([normalizationDecisions.claimId])
          .from(normalizationDecisions)
          .where(inArray(normalizationDecisions.claimId, claimIds))
          .orderBy(normalizationDecisions.claimId, desc(normalizationDecisions.createdAt))
      );
    },

    async listTermsByIds(termIds) {
      if (termIds.length === 0) {
        return [];
      }
      return withDbErrors('Canonical term', async () =>
        database.db
          .select(termColumns)
          .from(canonicalTerms)
          .where(inArray(canonicalTerms.termId, termIds))
      );
    }
  };
}
