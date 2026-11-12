import { describe, expect, it, vi } from 'vitest';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import type {
  ExtractionRecord,
  ParsingRepository
} from './parsing.repository.js';
import { createParsingService } from './parsing.service.js';
import type { UnmappedItem } from './parsing.table.js';

const documentId = '44444444-4444-4444-8444-444444444444';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

describe('parsing unmapped data service', () => {
  it('delegates the replacement to the repository in the given transaction', async () => {
    const items: UnmappedItem[] = [
      {
        label: 'Courses',
        text: 'Advanced TypeScript',
        sources: ['L12'],
        reason: 'unsupported_section'
      }
    ];
    const saved: ExtractionRecord = {
      extractionId: '55555555-5555-4555-8555-555555555555',
      documentId,
      status: 'succeeded',
      format: 'pdf',
      pageCount: 1,
      content: { version: 3, pages: [], blocks: [] },
      failures: [],
      unmappedData: items,
      parserVersion: 'pdf-test',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const saveUnmappedData = vi
      .fn<ParsingRepository['saveUnmappedData']>()
      .mockResolvedValue(saved);
    const repository: ParsingRepository = {
      saveExtraction: vi.fn(),
      saveUnmappedData,
      findByDocumentId: vi.fn()
    };
    const service = createParsingService({ parsers: [], repository });
    const transaction = {} as DatabaseExecutor;

    await expect(
      service.saveUnmappedData(documentId, items, transaction)
    ).resolves.toBe(saved);
    expect(saveUnmappedData).toHaveBeenCalledWith(documentId, items, transaction);
  });
});
