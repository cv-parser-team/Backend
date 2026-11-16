import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  isActiveAiRequest,
  normalizationAiRequests
} from './normalization.table.js';

export type AiRequestRecord = typeof normalizationAiRequests.$inferSelect;

export type EnqueueAiRequestInput = Pick<
  typeof normalizationAiRequests.$inferInsert,
  'claimId' | 'category' | 'originalValue' | 'context' | 'preferredTermIds'
>;

// A request as one worker claimed it. The attempt count identifies that claim:
// after the lease expires and another worker claims the request, the count
// grows, and writes with the old count no longer match.
export type ClaimedAiRequest = Pick<AiRequestRecord, 'requestId' | 'attemptCount'>;

export interface AiRequestRepository {
  // Replaces any active request of the claim, whose value is now outdated.
  enqueue(input: EnqueueAiRequestInput): Promise<AiRequestRecord>;
  // Claims runnable requests: queued and due, or processing with an expired
  // lease. Concurrent workers never claim the same request.
  claimBatch(limit: number, leaseMilliseconds: number): Promise<AiRequestRecord[]>;
  // Locks the request until the transaction ends, or returns null when this
  // claim no longer owns it.
  lockClaimed(
    claim: ClaimedAiRequest,
    transaction: DatabaseExecutor
  ): Promise<AiRequestRecord | null>;
  complete(claim: ClaimedAiRequest, transaction?: DatabaseExecutor): Promise<boolean>;
  supersede(claim: ClaimedAiRequest, transaction?: DatabaseExecutor): Promise<boolean>;
  retry(claim: ClaimedAiRequest, failureCode: string, delayMilliseconds: number): Promise<boolean>;
  fail(claim: ClaimedAiRequest, failureCode: string): Promise<boolean>;
}

// Matches the request only while it is still processing under this claim.
function ownedByClaim({ requestId, attemptCount }: ClaimedAiRequest) {
  return and(
    eq(normalizationAiRequests.requestId, requestId),
    eq(normalizationAiRequests.status, 'processing'),
    eq(normalizationAiRequests.attemptCount, attemptCount)
  );
}

export function createAiRequestRepository(database: AppDatabase): AiRequestRepository {
  async function finish(
    claim: ClaimedAiRequest,
    changes: PgUpdateSetSource<typeof normalizationAiRequests>,
    transaction: DatabaseExecutor = database.db
  ): Promise<boolean> {
    return withDbErrors('Normalization AI request', async () => {
      const updated = await transaction
        .update(normalizationAiRequests)
        .set({ ...changes, lockedUntil: null })
        .where(ownedByClaim(claim))
        .returning({ requestId: normalizationAiRequests.requestId });
      return updated.length > 0;
    });
  }

  return {
    async enqueue(input) {
      return withDbErrors('Normalization AI request', () =>
        database.db.transaction(async (transaction) => {
          await transaction
            .update(normalizationAiRequests)
            .set({ status: 'superseded', lockedUntil: null })
            .where(
              and(
                eq(normalizationAiRequests.claimId, input.claimId),
                isActiveAiRequest(normalizationAiRequests.status)
              )
            );
          const [request] = await transaction
            .insert(normalizationAiRequests)
            .values(input)
            .returning();
          if (!request) {
            throw new Error('Normalization AI request creation returned no record');
          }
          return request;
        })
      );
    },

    async claimBatch(limit, leaseMilliseconds) {
      return withDbErrors('Normalization AI requests', () => {
        const runnable = database.db
          .select({ requestId: normalizationAiRequests.requestId })
          .from(normalizationAiRequests)
          .where(
            or(
              and(
                eq(normalizationAiRequests.status, 'queued'),
                lte(normalizationAiRequests.availableAt, sql`now()`)
              ),
              and(
                eq(normalizationAiRequests.status, 'processing'),
                lte(normalizationAiRequests.lockedUntil, sql`now()`)
              )
            )
          )
          .orderBy(asc(normalizationAiRequests.availableAt))
          .limit(limit)
          .for('update', { skipLocked: true });

        return database.db
          .update(normalizationAiRequests)
          .set({
            status: 'processing',
            attemptCount: sql`${normalizationAiRequests.attemptCount} + 1`,
            lockedUntil: sql`now() + ${leaseMilliseconds} * interval '1 millisecond'`
          })
          .where(inArray(normalizationAiRequests.requestId, runnable))
          .returning();
      });
    },

    async lockClaimed(claim, transaction) {
      return withDbErrors('Normalization AI request', async () => {
        const [request] = await transaction
          .select()
          .from(normalizationAiRequests)
          .where(ownedByClaim(claim))
          .limit(1)
          .for('update');
        return request ?? null;
      });
    },

    complete(claim, transaction) {
      return finish(claim, { status: 'completed', failureCode: null }, transaction);
    },

    supersede(claim, transaction) {
      return finish(claim, { status: 'superseded' }, transaction);
    },

    retry(claim, failureCode, delayMilliseconds) {
      return finish(claim, {
        status: 'queued',
        failureCode,
        availableAt: sql`now() + ${delayMilliseconds} * interval '1 millisecond'`
      });
    },

    fail(claim, failureCode) {
      return finish(claim, { status: 'failed', failureCode });
    }
  };
}
