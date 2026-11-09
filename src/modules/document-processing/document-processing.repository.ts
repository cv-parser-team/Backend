import { and, asc, eq, lte, sql } from 'drizzle-orm';
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

export interface DocumentProcessingRepository {
  createQueuedJob(documentId: string): Promise<ProcessingJobRecord>;
  claimJob(
    input: ClaimProcessingJobInput
  ): Promise<ProcessingJobRecord | null>;
  completeJob(
    input: CompleteProcessingJobInput
  ): Promise<ProcessingJobRecord | null>;
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
