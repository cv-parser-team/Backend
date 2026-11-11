import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  createDocumentProcessingRepository,
  type ProcessingJobRecord
} from './document-processing.repository.js';
import { documentProcessingJobs } from './document-processing.table.js';

const expiredAt = new Date('2026-01-01T00:05:00.000Z');
const recoveredJob: ProcessingJobRecord = {
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
  status: 'queued',
  attemptCount: 1,
  failureCode: null,
  availableAt: new Date('2026-01-01T00:00:00.000Z'),
  lockedUntil: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: expiredAt
};

const queuedJob: ProcessingJobRecord = {
  ...recoveredJob,
  attemptCount: 0,
  updatedAt: recoveredJob.createdAt
};

interface ConflictTarget {
  target: unknown;
  where: SQL;
}

// Each insert returns the next result in `inserted`; each read of the active
// job returns the next result in `active`.
function createSchedulingDatabase(
  inserted: ProcessingJobRecord[][],
  active: ProcessingJobRecord[][]
) {
  const insertReturning = vi.fn(() => Promise.resolve(inserted.shift() ?? []));
  const onConflictDoNothing = vi.fn<
    (config: ConflictTarget) => { returning: typeof insertReturning }
  >(() => ({ returning: insertReturning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  const limit = vi.fn(() => Promise.resolve(active.shift() ?? []));
  const where = vi.fn<(condition: SQL) => { limit: typeof limit }>(() => ({
    limit
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    database: { db: { insert, select } } as unknown as AppDatabase,
    insert,
    values,
    onConflictDoNothing,
    select,
    where
  };
}

describe('scheduling a document processing job', () => {
  const dialect = new PgDialect();
  const documentId = queuedJob.documentId;

  it('creates a queued job when the document has no active job', async () => {
    const scheduling = createSchedulingDatabase([[queuedJob]], []);
    const repository = createDocumentProcessingRepository(scheduling.database);

    await expect(repository.createQueuedJob(documentId)).resolves.toEqual(queuedJob);

    expect(scheduling.values).toHaveBeenCalledWith({ documentId });
    expect(scheduling.select).not.toHaveBeenCalled();
  });

  it('skips the insert only on a conflict with an active job', async () => {
    const scheduling = createSchedulingDatabase([[queuedJob]], []);
    const repository = createDocumentProcessingRepository(scheduling.database);

    await repository.createQueuedJob(documentId);

    const conflict = scheduling.onConflictDoNothing.mock.calls[0]?.[0];
    expect(conflict?.target).toBe(documentProcessingJobs.documentId);
    expect(conflict ? dialect.sqlToQuery(conflict.where).sql : undefined).toBe(
      `"document_processing_jobs"."status" in ('queued', 'processing', 'retrying')`
    );
  });

  it('returns the active job instead of creating a second one', async () => {
    const activeJob: ProcessingJobRecord = { ...queuedJob, status: 'processing' };
    const scheduling = createSchedulingDatabase([[]], [[activeJob]]);
    const repository = createDocumentProcessingRepository(scheduling.database);

    await expect(repository.createQueuedJob(documentId)).resolves.toEqual(activeJob);

    expect(scheduling.insert).toHaveBeenCalledTimes(1);
    const condition = scheduling.where.mock.calls[0]?.[0];
    const query = condition ? dialect.sqlToQuery(condition) : undefined;
    expect(query?.sql).toContain('"document_processing_jobs"."document_id" = $1');
    expect(query?.sql).toContain(
      `"document_processing_jobs"."status" in ('queued', 'processing', 'retrying')`
    );
    expect(query?.params).toEqual([documentId]);
  });

  it('inserts again when the active job finished before it was read', async () => {
    const scheduling = createSchedulingDatabase([[], [queuedJob]], [[]]);
    const repository = createDocumentProcessingRepository(scheduling.database);

    await expect(repository.createQueuedJob(documentId)).resolves.toEqual(queuedJob);

    expect(scheduling.insert).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when no job can be created or found', async () => {
    const scheduling = createSchedulingDatabase([[], []], [[], []]);
    const repository = createDocumentProcessingRepository(scheduling.database);

    await expect(repository.createQueuedJob(documentId)).rejects.toThrow(
      `Document ${documentId} has neither a new nor an active processing job`
    );
  });
});

describe('finishing a claimed job', () => {
  const dialect = new PgDialect();
  const claim = {
    jobId: queuedJob.jobId,
    documentId: queuedJob.documentId,
    attemptCount: 2
  };

  function createFinishingDatabase() {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn<(condition: SQL) => { returning: typeof returning }>(
      () => ({ returning })
    );
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    return {
      database: { db: { update } } as unknown as AppDatabase,
      where
    };
  }

  it.each([
    [
      'complete',
      (repository: ReturnType<typeof createDocumentProcessingRepository>) =>
        repository.completeJob(claim)
    ],
    [
      'retry',
      (repository: ReturnType<typeof createDocumentProcessingRepository>) =>
        repository.retryJob({
          ...claim,
          failureCode: 'PARSING_FAILED',
          delayMilliseconds: 30_000
        })
    ],
    [
      'fail',
      (repository: ReturnType<typeof createDocumentProcessingRepository>) =>
        repository.failJob({ ...claim, failureCode: 'PARSING_FAILED' })
    ]
  ])('%s matches only the attempt that claimed the job', async (_name, finish) => {
    const finishing = createFinishingDatabase();

    await expect(
      finish(createDocumentProcessingRepository(finishing.database))
    ).resolves.toBeNull();

    const condition = finishing.where.mock.calls[0]?.[0];
    const query = condition ? dialect.sqlToQuery(condition) : undefined;
    expect(query?.sql).toContain('"document_processing_jobs"."status" = $3');
    expect(query?.sql).toContain('"document_processing_jobs"."attempt_count" = $4');
    expect(query?.params).toEqual([
      claim.jobId,
      claim.documentId,
      'processing',
      claim.attemptCount
    ]);
  });
});

describe('locking a claimed job', () => {
  const dialect = new PgDialect();
  const claim = {
    jobId: queuedJob.jobId,
    documentId: queuedJob.documentId,
    attemptCount: 2
  };

  function createLockingTransaction(rows: ProcessingJobRecord[]) {
    const lockFor = vi.fn(() => Promise.resolve(rows));
    const limit = vi.fn(() => ({ for: lockFor }));
    const where = vi.fn<(condition: SQL) => { limit: typeof limit }>(() => ({
      limit
    }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    return {
      transaction: { select } as unknown as DatabaseExecutor,
      where,
      lockFor
    };
  }

  // The database is never used: the lock must be taken in the transaction.
  const unusedDatabase = { db: {} } as unknown as AppDatabase;

  it('locks the job for update in the transaction while the claim owns it', async () => {
    const lockedJob: ProcessingJobRecord = { ...queuedJob, status: 'processing', attemptCount: 2 };
    const locking = createLockingTransaction([lockedJob]);
    const repository = createDocumentProcessingRepository(unusedDatabase);

    await expect(
      repository.lockClaimedJob(claim, locking.transaction)
    ).resolves.toEqual(lockedJob);

    expect(locking.lockFor).toHaveBeenCalledWith('update');
    const condition = locking.where.mock.calls[0]?.[0];
    const query = condition ? dialect.sqlToQuery(condition) : undefined;
    expect(query?.sql).toContain('"document_processing_jobs"."attempt_count" = $4');
    expect(query?.params).toEqual([
      claim.jobId,
      claim.documentId,
      'processing',
      claim.attemptCount
    ]);
  });

  it('returns null when another claim owns the job', async () => {
    const locking = createLockingTransaction([]);
    const repository = createDocumentProcessingRepository(unusedDatabase);

    await expect(
      repository.lockClaimedJob(claim, locking.transaction)
    ).resolves.toBeNull();
  });

  it('finishes the job in the given transaction', async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const transaction = { update } as unknown as DatabaseExecutor;
    const repository = createDocumentProcessingRepository(unusedDatabase);

    await repository.completeJob(claim, transaction);
    await repository.retryJob(
      { ...claim, failureCode: 'PARSING_FAILED', delayMilliseconds: 30_000 },
      transaction
    );
    await repository.failJob({ ...claim, failureCode: 'PARSING_FAILED' }, transaction);

    expect(update).toHaveBeenCalledTimes(3);
  });
});

describe('document processing repository', () => {
  it('atomically releases one bounded batch of expired processing leases', async () => {
    const expiredJobIds = {
      getSQL: () => sql`select job_id from document_processing_jobs`
    };
    const limit = vi.fn(() => expiredJobIds);
    const orderBy = vi.fn(() => ({ limit }));
    const selectionWhere = vi.fn<(condition: SQL) => { orderBy: typeof orderBy }>(
      () => ({ orderBy })
    );
    const from = vi.fn(() => ({ where: selectionWhere }));
    const select = vi.fn(() => ({ from }));

    const returning = vi.fn().mockResolvedValue([recoveredJob]);
    const updateWhere = vi.fn<(condition: SQL) => { returning: typeof returning }>(
      () => ({ returning })
    );
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));
    const database = {
      db: { select, update }
    } as unknown as AppDatabase;
    const repository = createDocumentProcessingRepository(database);

    await expect(repository.releaseExpiredLeases(expiredAt, 100)).resolves.toEqual([
      recoveredJob
    ]);

    const dialect = new PgDialect();
    const selectionCondition = selectionWhere.mock.calls[0]?.[0];
    expect(selectionCondition).toBeDefined();
    const selectionQuery = dialect.sqlToQuery(selectionCondition!);
    expect(selectionQuery.sql).toContain(
      '"document_processing_jobs"."status" = $1'
    );
    expect(selectionQuery.sql).toContain(
      '"document_processing_jobs"."locked_until" <= $2'
    );
    expect(selectionQuery.params).toEqual([
      'processing',
      expiredAt.toISOString()
    ]);
    expect(limit).toHaveBeenCalledWith(100);

    expect(set).toHaveBeenCalledWith({ status: 'queued', lockedUntil: null });
    const updateCondition = updateWhere.mock.calls[0]?.[0];
    expect(updateCondition).toBeDefined();
    const updateQuery = dialect.sqlToQuery(updateCondition!);
    expect(updateQuery.sql).toContain(
      '"document_processing_jobs"."status" = $1'
    );
    expect(updateQuery.sql).toContain(
      '"document_processing_jobs"."job_id" in (select job_id from document_processing_jobs)'
    );
    expect(updateQuery.params).toEqual(['processing']);
  });
});
