import { and, desc, eq } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { DictionaryLookup, DictionaryTerm } from './normalization.matching.js';
import { DictionaryWriter } from './normalization.seed.js';
import { aliases, canonicalTerms, normalizationDecisions } from './normalization.table.js';

export type NormalizationDecisionRecord = typeof normalizationDecisions.$inferSelect;
export type CreateNormalizationDecisionInput = Omit<
  typeof normalizationDecisions.$inferInsert,
  'normalizationId' | 'createdAt'
>;

export interface DecisionStore {
  saveDecision(input: CreateNormalizationDecisionInput): Promise<NormalizationDecisionRecord>;
  // The newest decision is the claim's current one.
  findLatestDecision(claimId: string): Promise<NormalizationDecisionRecord | null>;
}

export interface NormalizationRepository
  extends DictionaryLookup,
    DictionaryWriter,
    DecisionStore {}

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

    async saveDecision(input) {
      return withDbErrors('Normalization decision', async () => {
        const [decision] = await database.db
          .insert(normalizationDecisions)
          .values(input)
          .returning();
        if (!decision) {
          throw new Error('Normalization decision save did not return a record');
        }
        return decision;
      });
    },

    async findLatestDecision(claimId) {
      return withDbErrors('Normalization decision', async () => {
        const [decision] = await database.db
          .select()
          .from(normalizationDecisions)
          .where(eq(normalizationDecisions.claimId, claimId))
          .orderBy(desc(normalizationDecisions.createdAt))
          .limit(1);
        return decision ?? null;
      });
    }
  };
}
