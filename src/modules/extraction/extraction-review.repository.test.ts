import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { createExtractionReviewRepository } from './extraction-review.repository.js';
import { extractionReviewItems } from './extraction-review.table.js';
import type { ExtractionReviewItemDraft } from './extraction.mapper.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const invocationId = '22222222-2222-4222-8222-222222222222';
const dialect = new PgDialect();

const item: ExtractionReviewItemDraft = {
  claimType: 'employment',
  fields: {
    employer: { value: 'Example Corp', confidence: 0.9, sources: ['L1'] }
  },
  issues: [{ field: 'jobTitle', code: 'missing_job_title', required: true }],
  sources: ['L1'],
  fingerprint: 'abc123'
};

function database(db: unknown = {}): AppDatabase {
  return { db } as AppDatabase;
}

describe('extraction review repository', () => {
  it('lists only pending items from the supplied owned documents', async () => {
    const records = [{ reviewItemId: 'review-1' }];
    const orderBy = vi.fn(async () => records);
    const where = vi.fn((_condition: SQL) => ({ orderBy }));
    const from = vi.fn((table: unknown) => {
      expect(table).toBe(extractionReviewItems);
      return { where };
    });
    const select = vi.fn(() => ({ from }));
    const repository = createExtractionReviewRepository(database({ select }));

    await expect(
      repository.listPendingForDocuments([documentId])
    ).resolves.toBe(records);

    const query = dialect.sqlToQuery(where.mock.calls[0]![0]);
    expect(query.params).toEqual([documentId, 'pending']);
    expect(orderBy).toHaveBeenCalledOnce();
  });

  it('returns an empty list without querying when the owner has no documents', async () => {
    const select = vi.fn();
    const repository = createExtractionReviewRepository(database({ select }));

    await expect(repository.listPendingForDocuments([])).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('dismisses only a pending item at the expected version', async () => {
    const saved = { reviewItemId: 'review-1', status: 'dismissed', version: 2 };
    const returning = vi.fn(async () => [saved]);
    const where = vi.fn((_condition: SQL) => ({ returning }));
    const set = vi.fn((_values: unknown) => ({ where }));
    const update = vi.fn((table: unknown) => {
      expect(table).toBe(extractionReviewItems);
      return { set };
    });
    const repository = createExtractionReviewRepository(database({ update }));

    await expect(repository.dismissPending('review-1', 1)).resolves.toEqual({
      status: 'saved',
      record: saved
    });

    const query = dialect.sqlToQuery(where.mock.calls[0]![0]);
    expect(query.params).toEqual(['review-1', 'pending', 1]);
  });

  it('replaces only pending items for the document and inserts the new snapshot', async () => {
    const deletedWhere = vi.fn(async (_condition: SQL) => undefined);
    const deleteRow = vi.fn((table: unknown) => {
      expect(table).toBe(extractionReviewItems);
      return { where: deletedWhere };
    });
    const records = [{ reviewItemId: 'review-1' }];
    const returning = vi.fn(async () => records);
    const insertedValues = vi.fn((_values: unknown) => ({ returning }));
    const insert = vi.fn((table: unknown) => {
      expect(table).toBe(extractionReviewItems);
      return { values: insertedValues };
    });
    const transaction = { delete: deleteRow, insert } as unknown as DatabaseExecutor;
    const repository = createExtractionReviewRepository(database());

    await expect(
      repository.replacePendingForDocument(documentId, invocationId, [item], transaction)
    ).resolves.toBe(records);

    const query = dialect.sqlToQuery(deletedWhere.mock.calls[0]![0]);
    expect(query.params).toEqual([documentId, 'pending']);
    expect(insertedValues).toHaveBeenCalledWith([
      { documentId, extractionInvocationId: invocationId, ...item }
    ]);
  });

  it('clears an old pending snapshot without inserting when the new one is empty', async () => {
    const where = vi.fn(async () => undefined);
    const transaction = {
      delete: vi.fn(() => ({ where })),
      insert: vi.fn()
    } as unknown as DatabaseExecutor;
    const repository = createExtractionReviewRepository(database());

    await expect(
      repository.replacePendingForDocument(documentId, invocationId, [], transaction)
    ).resolves.toEqual([]);
    expect(where).toHaveBeenCalledOnce();
    expect(transaction.insert).not.toHaveBeenCalled();
  });
});
