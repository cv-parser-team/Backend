import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import {
  createDocumentProcessingRepository,
  type ProcessingJobRecord
} from './document-processing.repository.js';

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
