import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import {
  createParsingRepository,
  type ExtractionRecord
} from './parsing.repository.js';
import type { UnmappedItem } from './parsing.table.js';

const documentId = '44444444-4444-4444-8444-444444444444';
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const baseRecord: ExtractionRecord = {
  extractionId: '55555555-5555-4555-8555-555555555555',
  documentId,
  status: 'succeeded',
  format: 'pdf',
  pageCount: 1,
  content: { version: 3, pages: [], blocks: [] },
  failures: [],
  unmappedData: [],
  parserVersion: 'pdf-test',
  createdAt: timestamp,
  updatedAt: timestamp
};

function updateExecutor(returned?: ExtractionRecord) {
  const returning = vi.fn().mockResolvedValue(returned ? [returned] : []);
  const where = vi.fn<(condition: SQL) => { returning: typeof returning }>(
    () => ({ returning })
  );
  const set = vi.fn<
    (values: { unmappedData: UnmappedItem[]; updatedAt: Date }) => { where: typeof where }
  >(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  return { update, set, where };
}

describe('parsing repository', () => {
  it.each([
    [
      'mapped items',
      [
        {
          label: 'Courses',
          text: 'Advanced TypeScript',
          sources: ['L12'],
          reason: 'unsupported_section'
        }
      ] satisfies UnmappedItem[]
    ],
    ['an empty list', [] satisfies UnmappedItem[]]
  ])('replaces only unmapped data with %s in the given transaction', async (_case, items) => {
    const saved = { ...baseRecord, unmappedData: items };
    const transaction = updateExecutor(saved);
    const repository = createParsingRepository({ db: {} } as unknown as AppDatabase);

    await expect(
      repository.saveUnmappedData(
        documentId,
        items,
        transaction as unknown as DatabaseExecutor
      )
    ).resolves.toBe(saved);

    expect(transaction.set).toHaveBeenCalledWith({
      unmappedData: items,
      updatedAt: expect.any(Date)
    });
    expect(Object.keys(transaction.set.mock.calls[0]![0])).toEqual([
      'unmappedData',
      'updatedAt'
    ]);
    const query = new PgDialect().sqlToQuery(transaction.where.mock.calls[0]![0]);
    expect(query.sql).toBe('"document_extractions"."document_id" = $1');
    expect(query.params).toEqual([documentId]);
  });

  it('uses the database executor when no transaction is given', async () => {
    const executor = updateExecutor(baseRecord);
    const repository = createParsingRepository({
      db: executor
    } as unknown as AppDatabase);

    await expect(repository.saveUnmappedData(documentId, [])).resolves.toBe(baseRecord);
    expect(executor.update).toHaveBeenCalledOnce();
  });

  it('rejects a document without a stored extraction', async () => {
    const executor = updateExecutor();
    const repository = createParsingRepository({
      db: executor
    } as unknown as AppDatabase);

    await expect(repository.saveUnmappedData(documentId, [])).rejects.toBeInstanceOf(
      RecordNotFoundError
    );
  });
});
