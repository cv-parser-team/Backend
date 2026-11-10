import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import { documentProcessingJobs } from './document-processing.table.js';

export type ProcessingJobRecord = typeof documentProcessingJobs.$inferSelect;

export interface ClaimProcessingJobInput {
  jobId: string;
  documentId: string;
  leaseMilliseconds: number;
}

export interface CompleteProcessingJobInput {
  jobId: string;
  documentId: string;
}

export interface FailProcessingJobInput {
  jobId: string;
  documentId: string;
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
  completeJob(
    input: CompleteProcessingJobInput
  ): Promise<ProcessingJobRecord | null>;
  retryJob(
    input: RetryProcessingJobInput
  ): Promise<ProcessingJobRecord | null>;
  releaseAvailableRetries(
    availableAt: Date,
    limit: number
  ): Promise<ProcessingJobRecord[]>;
  releaseExpiredLeases(
    expiredAt: Date,
    limit: number
  ): Promise<ProcessingJobRecord[]>;
  failJob(input: FailProcessingJobInput): Promise<ProcessingJobRecord | null>;
  listPublishableJobs(
    availableAt: Date,
    limit: number
  ): Promise<ProcessingJobRecord[]>;
}

export function createDocumentProcessingRepository(
  database: AppDatabase
): DocumentProcessingRepository {
  return {
    async createQueuedJob(documentId) {
      return withDbErrors('Document processing job', async () => {
        const [createdJob] = await database.db
          .insert(documentProcessingJobs)
          .values({ documentId })
          .returning();

        if (!createdJob) {
          throw new Error('Document processing job creation returned no record');
        }

        return createdJob;
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

    async completeJob({ jobId, documentId }) {
      return withDbErrors('Document processing job', async () => {
        const [completedJob] = await database.db
          .update(documentProcessingJobs)
          .set({
            status: 'completed',
            failureCode: null,
            lockedUntil: null
          })
          .where(
            and(
              eq(documentProcessingJobs.jobId, jobId),
              eq(documentProcessingJobs.documentId, documentId),
              eq(documentProcessingJobs.status, 'processing')
            )
          )
          .returning();

        return completedJob ?? null;
      });
    },

    async retryJob({
      jobId,
      documentId,
      failureCode,
      delayMilliseconds
    }) {
      return withDbErrors('Document processing job', async () => {
        const [retryingJob] = await database.db
          .update(documentProcessingJobs)
          .set({
            status: 'retrying',
            failureCode,
            availableAt:
              sql`now() + ${delayMilliseconds} * interval '1 millisecond'`,
            lockedUntil: null
          })
          .where(
            and(
              eq(documentProcessingJobs.jobId, jobId),
              eq(documentProcessingJobs.documentId, documentId),
              eq(documentProcessingJobs.status, 'processing')
            )
          )
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

    async failJob({ jobId, documentId, failureCode }) {
      return withDbErrors('Document processing job', async () => {
        const [failedJob] = await database.db
          .update(documentProcessingJobs)
          .set({
            status: 'failed',
            failureCode,
            lockedUntil: null
          })
          .where(
            and(
              eq(documentProcessingJobs.jobId, jobId),
              eq(documentProcessingJobs.documentId, documentId),
              eq(documentProcessingJobs.status, 'processing')
            )
          )
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
