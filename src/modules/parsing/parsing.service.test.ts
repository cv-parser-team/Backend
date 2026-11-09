import { getTableConfig } from 'drizzle-orm/pg-core';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../testing/create-test-app.js';
import { createDocxParser } from './docx-parser.js';
import { UnsupportedDocumentTypeError } from './parsing.errors.js';
import { ExtractionRecord, ParsingRepository } from './parsing.repository.js';
import { createParsingService } from './parsing.service.js';
import { documentExtractions, EXTRACTION_CONTENT_VERSION } from './parsing.table.js';
import { DocumentFormat, DocumentParser, ExtractionResult } from './parsing.types.js';
import { createPdfParser } from './pdf-parser.js';

const documentId = '44444444-4444-4444-8444-444444444444';
const pdfMediaType = 'application/pdf';
const docxMediaType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function createParserDouble(format: DocumentFormat, mediaType: string): DocumentParser {
  const result: ExtractionResult = {
    status: 'succeeded',
    format,
    pageCount: null,
    pages: [],
    blocks: [],
    failures: [],
    parserVersion: `${format}-double`
  };
  return { format, mediaTypes: [mediaType], parse: vi.fn().mockResolvedValue(result) };
}

function createRepositoryDouble(): ParsingRepository {
  return {
    saveExtraction: vi.fn(
      async (savedDocumentId: string, result: ExtractionResult): Promise<ExtractionRecord> => ({
        extractionId: '55555555-5555-4555-8555-555555555555',
        documentId: savedDocumentId,
        status: result.status,
        format: result.format,
        pageCount: result.pageCount,
        content: {
          version: EXTRACTION_CONTENT_VERSION,
          pages: result.pages,
          blocks: result.blocks
        },
        failures: result.failures,
        unmappedData: [],
        parserVersion: result.parserVersion,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z')
      })
    ),
    findByDocumentId: vi.fn().mockResolvedValue(null)
  };
}

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

describe('parsing module', () => {
  it('shares the parsing service with other modules', async () => {
    const app = await createTestApp();
    try {
      await app.ready();
      expect(app.hasDecorator('parsingService')).toBe(true);
      expect(typeof app.parsingService.extract).toBe('function');
    } finally {
      await app.close();
    }
  });
});

describe('document extractions table', () => {
  it('keeps one extraction per document and deletes it with the document', () => {
    const config = getTableConfig(documentExtractions);
    const documentIndex = config.indexes.find(
      (index) => index.config.name === 'document_extractions_document_id_unique'
    );
    const [foreignKey] = config.foreignKeys;

    expect(documentIndex?.config.unique).toBe(true);
    expect(config.foreignKeys).toHaveLength(1);
    expect(getTableConfig(foreignKey!.reference().foreignTable).name).toBe('documents');
    expect(foreignKey!.onDelete).toBe('cascade');
  });

  it('keeps unmapped information in a list that starts empty', () => {
    const column = getTableConfig(documentExtractions).columns.find(
      (candidate) => candidate.name === 'unmapped_data'
    );

    expect(column?.columnType).toBe('PgJsonb');
    expect(column?.notNull).toBe(true);
    expect(column?.default).toEqual([]);
  });
});

describe('parsing service', () => {
  it('chooses the parser that reads the media type', async () => {
    const pdfParser = createParserDouble('pdf', pdfMediaType);
    const docxParser = createParserDouble('docx', docxMediaType);
    const service = createParsingService({
      parsers: [pdfParser, docxParser],
      repository: createRepositoryDouble()
    });
    const content = new Uint8Array([1, 2, 3]);

    const pdfResult = await service.extract({ documentId, content, mediaType: pdfMediaType });
    const docxResult = await service.extract({ documentId, content, mediaType: docxMediaType });

    expect(pdfResult.format).toBe('pdf');
    expect(docxResult.format).toBe('docx');
    expect(pdfParser.parse).toHaveBeenCalledOnce();
    expect(pdfParser.parse).toHaveBeenCalledWith(content);
    expect(docxParser.parse).toHaveBeenCalledOnce();
  });

  it('saves the extraction for the document', async () => {
    const pdfParser = createParserDouble('pdf', pdfMediaType);
    const repository = createRepositoryDouble();
    const service = createParsingService({ parsers: [pdfParser], repository });

    const saved = await service.extract({
      documentId,
      content: new Uint8Array(),
      mediaType: pdfMediaType
    });

    expect(repository.saveExtraction).toHaveBeenCalledWith(
      documentId,
      expect.objectContaining({ status: 'succeeded', format: 'pdf' })
    );
    expect(saved.documentId).toBe(documentId);
  });

  it('rejects media types without a parser and saves nothing', async () => {
    const pdfParser = createParserDouble('pdf', pdfMediaType);
    const repository = createRepositoryDouble();
    const service = createParsingService({ parsers: [pdfParser], repository });

    await expect(
      service.extract({ documentId, content: new Uint8Array(), mediaType: 'image/png' })
    ).rejects.toBeInstanceOf(UnsupportedDocumentTypeError);
    expect(pdfParser.parse).not.toHaveBeenCalled();
    expect(repository.saveExtraction).not.toHaveBeenCalled();
  });

  it('parses and saves real PDF and DOCX files', async () => {
    const service = createParsingService({
      parsers: [createPdfParser(), createDocxParser()],
      repository: createRepositoryDouble()
    });

    const pdf = await service.extract({
      documentId,
      content: await readFixture('multi-page.pdf'),
      mediaType: pdfMediaType
    });
    const docx = await service.extract({
      documentId,
      content: await readFixture('resume.docx'),
      mediaType: docxMediaType
    });

    expect(pdf).toMatchObject({ status: 'succeeded', format: 'pdf', pageCount: 3 });
    expect(pdf.content.pages).toHaveLength(3);
    expect(docx).toMatchObject({ status: 'succeeded', format: 'docx', pageCount: null });
    expect(docx.content.blocks[0]).toMatchObject({ type: 'paragraph', text: 'Sample Candidate' });
  });
});
