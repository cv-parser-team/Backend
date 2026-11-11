import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  createDocumentsRepository,
  type DocumentRecord
} from './documents.repository.js';

const documentId = '22222222-2222-4222-8222-222222222222';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

const processingDocument: DocumentRecord = {
  documentId,
  ownerUserId: '11111111-1111-4111-8111-111111111111',
  purpose: 'source',
  originalFilename: 'resume.pdf',
  mediaType: 'application/pdf',
  byteSize: 1024,
  sha256: 'a'.repeat(64),
  storageKey: 'documents/example',
  status: 'processing',
  failureCode: null,
  createdAt: timestamp,
  updatedAt: timestamp
};

describe('documents repository', () => {
  it('marks only stored, already-processing, or failed documents as processing', async () => {
    const returning = vi.fn().mockResolvedValue([processingDocument]);
    const where = vi.fn<(condition: SQL) => { returning: typeof returning }>(
      () => ({ returning })
    );
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const database = { db: { update } } as unknown as AppDatabase;
    const repository = createDocumentsRepository(database);

    await expect(repository.markDocumentProcessing(documentId)).resolves.toBe(
      processingDocument
    );

    const condition = where.mock.calls[0]?.[0];
    expect(condition).toBeDefined();
    const query = new PgDialect().sqlToQuery(condition!);
    expect(query.sql).toContain('"documents"."document_id" = $1');
    expect(query.sql).toContain('"documents"."status" in ($2, $3, $4)');
    expect(query.params).toEqual([documentId, 'stored', 'processing', 'failed']);
  });

  function createUpdateExecutor() {
    const returning = vi.fn().mockResolvedValue([processingDocument]);
    const where = vi.fn<(condition: SQL) => { returning: typeof returning }>(
      () => ({ returning })
    );
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    return { update, set, where };
  }

  it('marks ready and failed only from processing, in the given transaction', async () => {
    const transaction = createUpdateExecutor();
    // The database is never used: both writes must join the transaction.
    const repository = createDocumentsRepository({ db: {} } as unknown as AppDatabase);

    await repository.markDocumentReady(
      documentId,
      transaction as unknown as DatabaseExecutor
    );
    await repository.markDocumentFailed(
      { documentId, failureCode: 'PARSING_FAILED' },
      transaction as unknown as DatabaseExecutor
    );

    expect(transaction.set).toHaveBeenNthCalledWith(1, {
      status: 'ready',
      failureCode: null
    });
    expect(transaction.set).toHaveBeenNthCalledWith(2, {
      status: 'failed',
      failureCode: 'PARSING_FAILED'
    });
    for (const [condition] of transaction.where.mock.calls) {
      const query = new PgDialect().sqlToQuery(condition);
      expect(query.sql).toContain('"documents"."status" = $2');
      expect(query.params).toEqual([documentId, 'processing']);
    }
  });

  it('locks the document for update in the transaction', async () => {
    const lockFor = vi.fn().mockResolvedValue([processingDocument]);
    const limit = vi.fn(() => ({ for: lockFor }));
    const where = vi.fn<(condition: SQL) => { limit: typeof limit }>(() => ({
      limit
    }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const repository = createDocumentsRepository({ db: {} } as unknown as AppDatabase);

    await expect(
      repository.lockDocument(documentId, { select } as unknown as DatabaseExecutor)
    ).resolves.toBe(processingDocument);

    expect(lockFor).toHaveBeenCalledWith('update');
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(query.sql).toBe('"documents"."document_id" = $1');
    expect(query.params).toEqual([documentId]);
  });

  it('marks ready on the database when no transaction is given', async () => {
    const executor = createUpdateExecutor();
    const repository = createDocumentsRepository({
      db: executor
    } as unknown as AppDatabase);

    await expect(repository.markDocumentReady(documentId)).resolves.toBe(
      processingDocument
    );
    expect(executor.update).toHaveBeenCalledOnce();
  });
});
