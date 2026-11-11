import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
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
  it('marks only stored or already-processing documents as processing', async () => {
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
    expect(query.sql).toContain('"documents"."status" in ($2, $3)');
    expect(query.params).toEqual([documentId, 'stored', 'processing']);
  });
});
