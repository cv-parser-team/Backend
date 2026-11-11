import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  documentProcessingJobs,
  isActiveJob
} from './document-processing.table.js';

export type ProcessingJobRecord = typeof documentProcessingJobs.$inferSelect;

export interface ClaimProcessingJobInput {
  jobId: string;
  documentId: string;
  leaseMilliseconds: number;
}

// The job as one worker claimed it. Its attempt count identifies that claim:
// once the lease expires and another worker claims the job, the count grows,
// and writes with the old count no longer match.
export type ClaimedProcessingJob = Pick<
  ProcessingJobRecord,
  'jobId' | 'documentId' | 'attemptCount'
>;

export type CompleteProcessingJobInput = ClaimedProcessingJob;

export interface FailProcessingJobInput extends ClaimedProcessingJob {
  failureCode: string;
}

export interface RetryProcessingJobInput extends FailProcessingJobInput {
  delayMilliseconds: number;
}

export interface DocumentProcessingRepository {
  createQueuedJob(documentId: string): Promise<ProcessingJobRecord>;
  claimJob(
    input: ClaimProcessingJobInput
  ): Promise<ProcessingJobRecord | null>;
  // Locks the job until the transaction ends, or returns null when this claim
  // no longer owns it. While locked, lease recovery cannot take the job.
  lockClaimedJob(
    claim: ClaimedProcessingJob,
    transaction: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  completeJob(
    input: CompleteProcessingJobInput,
    transaction?: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  retryJob(
    input: RetryProcessingJobInput,
    transaction?: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  releaseAvailableRetries(
    availableAt: Date,
    limit: number
  ): Promise<ProcessingJobRecord[]>;
  releaseExpiredLeases(
    expiredAt: Date,
    limit: number
  ): Promise<ProcessingJobRecord[]>;
  failJob(
    input: FailProcessingJobInput,
    transaction?: DatabaseExecutor
  ): Promise<ProcessingJobRecord | null>;
  listPublishableJobs(
    availableAt: Date,
    limit: number
  ): Promise<ProcessingJobRecord[]>;
}

// Matches the job only while it is still processing under this claim.
function ownedByClaim({ jobId, documentId, attemptCount }: ClaimedProcessingJob) {
  return and(
    eq(documentProcessingJobs.jobId, jobId),
    eq(documentProcessingJobs.documentId, documentId),
    eq(documentProcessingJobs.status, 'processing'),
    eq(documentProcessingJobs.attemptCount, attemptCount)
  );
}

export function createDocumentProcessingRepository(
  database: AppDatabase
): DocumentProcessingRepository {
  return {
    // A document has at most one active job, so scheduling it again returns
    // the job that will already run instead of creating a duplicate.
    async createQueuedJob(documentId) {
      return withDbErrors('Document processing job', async () => {
        // The active job can finish between the conflict and the read, so the
        // insert is tried once more before giving up.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const [createdJob] = await database.db
            .insert(documentProcessingJobs)
            .values({ documentId })
            .onConflictDoNothing({
              target: documentProcessingJobs.documentId,
              where: isActiveJob(documentProcessingJobs.status)
            })
            .returning();

          if (createdJob) {
            return createdJob;
          }

          const [activeJob] = await database.db
            .select()
            .from(documentProcessingJobs)
            .where(
              and(
                eq(documentProcessingJobs.documentId, documentId),
                isActiveJob(documentProcessingJobs.status)
              )
            )
            .limit(1);

          if (activeJob) {
            return activeJob;
          }
        }

        throw new Error(
          `Document ${documentId} has neither a new nor an active processing job`
        );
      });
    },

    async claimJob({ jobId, documentId, leaseMilliseconds }) {
      return withDbErrors('Document processing job', async () => {
        const [claimedJob] = await database.db
          .update(documentProcessingJobs)
          .set({
            status: 'processing',
            attemptCount: sql`${documentProcessingJobs.attemptCount} + 1`,
            failureCode: null,
            lockedUntil:
              sql`now() + ${leaseMilliseconds} * interval '1 millisecond'`
          })
          .where(
            and(
              eq(documentProcessingJobs.jobId, jobId),
              eq(documentProcessingJobs.documentId, documentId),
              eq(documentProcessingJobs.status, 'queued'),
              lte(documentProcessingJobs.availableAt, sql`now()`)
            )
          )
          .returning();

        return claimedJob ?? null;
      });
    },

    async lockClaimedJob(claim, transaction) {
      return withDbErrors('Document processing job', async () => {
        const [lockedJob] = await transaction
          .select()
          .from(documentProcessingJobs)
          .where(ownedByClaim(claim))
          .limit(1)
          .for('update');

        return lockedJob ?? null;
      });
    },

    async completeJob(claimedJob, transaction = database.db) {
      return withDbErrors('Document processing job', async () => {
        const [completedJob] = await transaction
          .update(documentProcessingJobs)
          .set({
            status: 'completed',
            failureCode: null,
            lockedUntil: null
          })
          .where(ownedByClaim(claimedJob))
          .returning();

        return completedJob ?? null;
      });
    },

    async retryJob(
      { failureCode, delayMilliseconds, ...claimedJob },
      transaction = database.db
    ) {
      return withDbErrors('Document processing job', async () => {
        const [retryingJob] = await transaction
          .update(documentProcessingJobs)
          .set({
            status: 'retrying',
            failureCode,
            availableAt:
              sql`now() + ${delayMilliseconds} * interval '1 millisecond'`,
            lockedUntil: null
          })
          .where(ownedByClaim(claimedJob))
          .returning();

        return retryingJob ?? null;
      });
    },

    async releaseAvailableRetries(availableAt, limit) {
      return withDbErrors('Document processing jobs', () => {
        const availableRetryIds = database.db
          .select({ jobId: documentProcessingJobs.jobId })
          .from(documentProcessingJobs)
          .where(
            and(
              eq(documentProcessingJobs.status, 'retrying'),
              lte(documentProcessingJobs.availableAt, availableAt)
            )
          )
          .orderBy(
            asc(documentProcessingJobs.availableAt),
            asc(documentProcessingJobs.jobId)
          )
          .limit(limit);

        return database.db
          .update(documentProcessingJobs)
          .set({ status: 'queued' })
          .where(
            and(
              eq(documentProcessingJobs.status, 'retrying'),
              inArray(documentProcessingJobs.jobId, availableRetryIds)
            )
          )
          .returning();
      });
    },

    async releaseExpiredLeases(expiredAt, limit) {
      return withDbErrors('Document processing jobs', () => {
        const expiredLeaseJobIds = database.db
          .select({ jobId: documentProcessingJobs.jobId })
          .from(documentProcessingJobs)
          .where(
            and(
              eq(documentProcessingJobs.status, 'processing'),
              lte(documentProcessingJobs.lockedUntil, expiredAt)
            )
          )
          .orderBy(
            asc(documentProcessingJobs.lockedUntil),
            asc(documentProcessingJobs.jobId)
          )
          .limit(limit);

        return database.db
          .update(documentProcessingJobs)
          .set({ status: 'queued', lockedUntil: null })
          .where(
            and(
              eq(documentProcessingJobs.status, 'processing'),
              inArray(documentProcessingJobs.jobId, expiredLeaseJobIds)
            )
          )
          .returning();
      });
    },

    async failJob({ failureCode, ...claimedJob }, transaction = database.db) {
      return withDbErrors('Document processing job', async () => {
        const [failedJob] = await transaction
          .update(documentProcessingJobs)
          .set({
            status: 'failed',
            failureCode,
            lockedUntil: null
          })
          .where(ownedByClaim(claimedJob))
          .returning();

        return failedJob ?? null;
      });
    },

    async listPublishableJobs(availableAt, limit) {
      return withDbErrors('Document processing jobs', () =>
        database.db
          .select()
          .from(documentProcessingJobs)
          .where(
            and(
              eq(documentProcessingJobs.status, 'queued'),
              lte(documentProcessingJobs.availableAt, availableAt)
            )
          )
          .orderBy(
            asc(documentProcessingJobs.availableAt),
            asc(documentProcessingJobs.jobId)
          )
          .limit(limit)
      );
    }
  };
}
