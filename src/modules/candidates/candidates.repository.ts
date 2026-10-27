import { and, asc, eq, inArray } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import {
  candidates,
  ClaimFieldValue,
  claims,
  claimValueHistory
} from './candidates.table.js';

export type CandidateRecord = typeof candidates.$inferSelect;
export type CreateCandidateInput = Omit<
  typeof candidates.$inferInsert,
  'candidateId' | 'createdAt' | 'updatedAt'
>;
export type UpdateCandidateInput = Partial<
  Pick<
    typeof candidates.$inferInsert,
    'fullName' | 'headline' | 'summary' | 'phone' | 'location' | 'profileLinks'
  >
>;

type ClaimRow = typeof claims.$inferSelect;
export type ClaimValues = Record<string, ClaimFieldValue>;

export interface ClaimRecord {
  claimId: string;
  claimType: ClaimRow['claimType'];
  origin: ClaimRow['origin'];
  status: ClaimRow['status'];
  values: ClaimValues;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateClaimInput {
  candidateId: string;
  claimType: ClaimRow['claimType'];
  origin: ClaimRow['origin'];
  status: ClaimRow['status'];
  values: ClaimValues;
}

export interface ClaimFilters {
  claimType?: ClaimRow['claimType'];
  status?: ClaimRow['status'];
}

export interface UpdateClaimValuesInput {
  candidateId: string;
  claimId: string;
  changedValues: ClaimValues;
  removedFields: string[];
}

export interface CandidatesRepository {
  findCandidateByUserId(userId: string): Promise<CandidateRecord | null>;
  createCandidate(input: CreateCandidateInput): Promise<CandidateRecord>;
  updateCandidate(
    candidateId: string,
    input: UpdateCandidateInput
  ): Promise<CandidateRecord>;
  createClaim(input: CreateClaimInput): Promise<ClaimRecord>;
  listClaims(candidateId: string, filters?: ClaimFilters): Promise<ClaimRecord[]>;
  findClaim(candidateId: string, claimId: string): Promise<ClaimRecord | null>;
  updateClaimValues(input: UpdateClaimValuesInput): Promise<ClaimRecord | null>;
  deleteClaim(candidateId: string, claimId: string): Promise<boolean>;
}

type QueryExecutor = Pick<AppDatabase['db'], 'select'>;

function toClaimRecord(row: ClaimRow, values: ClaimValues): ClaimRecord {
  return {
    claimId: row.claimId,
    claimType: row.claimType,
    origin: row.origin,
    status: row.status,
    values,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function attachCurrentValues(
  executor: QueryExecutor,
  rows: ClaimRow[]
): Promise<ClaimRecord[]> {
  if (rows.length === 0) {
    return [];
  }

  const valueRows = await executor
    .select({
      claimId: claimValueHistory.claimId,
      fieldName: claimValueHistory.fieldName,
      value: claimValueHistory.value
    })
    .from(claimValueHistory)
    .where(
      and(
        inArray(
          claimValueHistory.claimId,
          rows.map((row) => row.claimId)
        ),
        eq(claimValueHistory.valueStatus, 'current')
      )
    );

  const valuesByClaim = new Map<string, ClaimValues>();
  for (const valueRow of valueRows) {
    const values = valuesByClaim.get(valueRow.claimId) ?? {};
    values[valueRow.fieldName] = valueRow.value;
    valuesByClaim.set(valueRow.claimId, values);
  }

  return rows.map((row) =>
    toClaimRecord(row, valuesByClaim.get(row.claimId) ?? {})
  );
}

export function createCandidatesRepository(
  database: AppDatabase
): CandidatesRepository {
  return {
    async findCandidateByUserId(userId) {
      return withDbErrors('Candidate', async () => {
        const [candidate] = await database.db
          .select()
          .from(candidates)
          .where(eq(candidates.userId, userId))
          .limit(1);

        return candidate ?? null;
      });
    },

    async createCandidate(input) {
      return withDbErrors('Candidate', async () => {
        const [createdCandidate] = await database.db
          .insert(candidates)
          .values(input)
          .returning();

        if (!createdCandidate) {
          throw new Error('Candidate creation did not return a record');
        }

        return createdCandidate;
      });
    },

    async updateCandidate(candidateId, input) {
      return withDbErrors('Candidate', async () => {
        const [updatedCandidate] = await database.db
          .update(candidates)
          .set(input)
          .where(eq(candidates.candidateId, candidateId))
          .returning();

        if (!updatedCandidate) {
          throw new RecordNotFoundError('Candidate', candidateId);
        }

        return updatedCandidate;
      });
    },

    async createClaim(input) {
      return withDbErrors('Claim', () => {
        return database.db.transaction(async (transaction) => {
          const [createdClaim] = await transaction
            .insert(claims)
            .values({
              candidateId: input.candidateId,
              claimType: input.claimType,
              origin: input.origin,
              status: input.status
            })
            .returning();

          if (!createdClaim) {
            throw new Error('Claim creation did not return a record');
          }

          const valueEntries = Object.entries(input.values);
          if (valueEntries.length > 0) {
            await transaction.insert(claimValueHistory).values(
              valueEntries.map(([fieldName, value]) => ({
                claimId: createdClaim.claimId,
                fieldName,
                value
              }))
            );
          }

          return toClaimRecord(createdClaim, { ...input.values });
        });
      });
    },

    async listClaims(candidateId, filters = {}) {
      return withDbErrors('Claims', async () => {
        const rows = await database.db
          .select()
          .from(claims)
          .where(
            and(
              eq(claims.candidateId, candidateId),
              filters.claimType ? eq(claims.claimType, filters.claimType) : undefined,
              filters.status ? eq(claims.status, filters.status) : undefined
            )
          )
          .orderBy(asc(claims.createdAt));

        return attachCurrentValues(database.db, rows);
      });
    },

    async findClaim(candidateId, claimId) {
      return withDbErrors('Claim', async () => {
        const rows = await database.db
          .select()
          .from(claims)
          .where(
            and(eq(claims.claimId, claimId), eq(claims.candidateId, candidateId))
          )
          .limit(1);

        const [claim] = await attachCurrentValues(database.db, rows);
        return claim ?? null;
      });
    },

    async updateClaimValues(input) {
      return withDbErrors('Claim', () => {
        return database.db.transaction(async (transaction) => {
          // Updating the claim first both verifies ownership and records the
          // edit time; nothing else is written when the claim is not owned.
          const [claim] = await transaction
            .update(claims)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(claims.claimId, input.claimId),
                eq(claims.candidateId, input.candidateId)
              )
            )
            .returning();

          if (!claim) {
            return null;
          }

          const changedEntries = Object.entries(input.changedValues);
          const supersededFields = [
            ...changedEntries.map(([fieldName]) => fieldName),
            ...input.removedFields
          ];

          if (supersededFields.length > 0) {
            await transaction
              .update(claimValueHistory)
              .set({ valueStatus: 'superseded' })
              .where(
                and(
                  eq(claimValueHistory.claimId, claim.claimId),
                  inArray(claimValueHistory.fieldName, supersededFields),
                  eq(claimValueHistory.valueStatus, 'current')
                )
              );
          }

          if (changedEntries.length > 0) {
            await transaction.insert(claimValueHistory).values(
              changedEntries.map(([fieldName, value]) => ({
                claimId: claim.claimId,
                fieldName,
                value
              }))
            );
          }

          const [updatedClaim] = await attachCurrentValues(transaction, [claim]);
          return updatedClaim ?? null;
        });
      });
    },

    async deleteClaim(candidateId, claimId) {
      return withDbErrors('Claim', async () => {
        const deleted = await database.db
          .delete(claims)
          .where(
            and(eq(claims.claimId, claimId), eq(claims.candidateId, candidateId))
          )
          .returning({ claimId: claims.claimId });

        return deleted.length > 0;
      });
    }
  };
}
