import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessingDocumentsService } from '../documents/index.js';
import type { DocumentRecord } from '../documents/documents.repository.js';
import type { ParsingService } from '../parsing/index.js';
import type { ExtractionRecord } from '../parsing/parsing.repository.js';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type { DocumentProcessingService } from './document-processing.service.js';
import { createParseDocumentHandler } from './parse-document.handler.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const job: ParseDocumentJob = {
  version: 1,
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222'
};
const timestamp = new Date('2026-01-01T00:00:00.000Z');

function createProcessingJob(
  status: ProcessingJobRecord['status'] = 'processing'
): ProcessingJobRecord {
  return {
    jobId: job.jobId,
    documentId: job.documentId,
    status,
    attemptCount: 1,
    failureCode: null,
    availableAt: timestamp,
    lockedUntil:
      status === 'processing' ? new Date('2026-01-01T00:05:00Z') : null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createDocument(status: DocumentRecord['status']): DocumentRecord {
  return {
    documentId: job.documentId,
    ownerUserId: '33333333-3333-4333-8333-333333333333',
    purpose: 'source',
    originalFilename: 'resume.pdf',
    mediaType: 'application/pdf',
    byteSize: 14,
    sha256: 'a'.repeat(64),
    storageKey: 'documents/resume',
    status,
    failureCode: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createExtraction(): ExtractionRecord {
  return {
    extractionId: '44444444-4444-4444-8444-444444444444',
    documentId: job.documentId,
    status: 'succeeded',
    format: 'pdf',
    pageCount: 1,
    content: { version: 3, pages: [], blocks: [] },
    failures: [],
    unmappedData: [],
    parserVersion: 'test',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createProcessingService(
  claimResult: ProcessingJobRecord | null = createProcessingJob(),
  completeResult: ProcessingJobRecord | null = createProcessingJob('completed')
): Pick<DocumentProcessingService, 'claim' | 'complete'> {
  return {
    claim: vi.fn().mockResolvedValue(claimResult),
    complete: vi.fn().mockResolvedValue(completeResult)
  };
}

function createDocumentsService(
  overrides: Partial<ProcessingDocumentsService> = {}
): ProcessingDocumentsService {
  const processingDocument = createDocument('processing');

  return {
    markDocumentProcessing: vi.fn().mockResolvedValue(processingDocument),
    openDocumentForProcessing: vi.fn().mockResolvedValue({
      document: processingDocument,
      stream: Readable.from('document bytes')
    }),
    markDocumentReady: vi.fn().mockResolvedValue(createDocument('ready')),
    ...overrides
  };
}

function createParsingService(): Pick<ParsingService, 'extract'> {
  return {
    extract: vi.fn().mockResolvedValue(createExtraction())
  };
}

describe('parse document handler', () => {
  it('processes a claimed document in lifecycle order', async () => {
    const operations: string[] = [];
    const completedJob = createProcessingJob('completed');
    const processingDocument = createDocument('processing');
    const processingService: Pick<
      DocumentProcessingService,
      'claim' | 'complete'
    > = {
      claim: vi.fn(async () => {
        operations.push('claim');
        return createProcessingJob();
      }),
      complete: vi.fn(async () => {
        operations.push('complete-job');
        return completedJob;
      })
    };
    const documentsService = createDocumentsService({
      markDocumentProcessing: vi.fn(async () => {
        operations.push('mark-processing');
        return processingDocument;
      }),
      openDocumentForProcessing: vi.fn(async () => {
        operations.push('open');
        return {
          document: processingDocument,
          stream: Readable.from('document bytes')
        };
      }),
      markDocumentReady: vi.fn(async () => {
        operations.push('mark-ready');
        return createDocument('ready');
      })
    });
    const parsingService: Pick<ParsingService, 'extract'> = {
      extract: vi.fn(async () => {
        operations.push('extract');
        return createExtraction();
      })
    };
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      processingService
    });

    await expect(handler.handle(job)).resolves.toEqual({
      outcome: 'processed',
      processingJob: completedJob
    });
    expect(operations).toEqual([
      'claim',
      'mark-processing',
      'open',
      'extract',
      'mark-ready',
      'complete-job'
    ]);
    expect(parsingService.extract).toHaveBeenCalledWith({
      documentId: job.documentId,
      mediaType: 'application/pdf',
      content: Buffer.from('document bytes')
    });
  });

  it('skips an unavailable delivery without touching the document', async () => {
    const processingService = createProcessingService(null);
    const documentsService = createDocumentsService();
    const parsingService = createParsingService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      processingService
    });

    await expect(handler.handle(job)).resolves.toEqual({ outcome: 'skipped' });
    expect(documentsService.markDocumentProcessing).not.toHaveBeenCalled();
    expect(documentsService.openDocumentForProcessing).not.toHaveBeenCalled();
    expect(documentsService.markDocumentReady).not.toHaveBeenCalled();
    expect(parsingService.extract).not.toHaveBeenCalled();
    expect(processingService.complete).not.toHaveBeenCalled();
  });

  it('stops when the document cannot transition to processing', async () => {
    const processingService = createProcessingService();
    const documentsService = createDocumentsService({
      markDocumentProcessing: vi.fn().mockResolvedValue(null)
    });
    const parsingService = createParsingService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      processingService
    });

    await expect(handler.handle(job)).rejects.toThrow(
      `Document ${job.documentId} could not transition to processing`
    );
    expect(documentsService.openDocumentForProcessing).not.toHaveBeenCalled();
    expect(parsingService.extract).not.toHaveBeenCalled();
    expect(processingService.complete).not.toHaveBeenCalled();
  });

  it('stops when the document cannot transition to ready', async () => {
    const processingService = createProcessingService();
    const documentsService = createDocumentsService({
      markDocumentReady: vi.fn().mockResolvedValue(null)
    });
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService: createParsingService(),
      processingService
    });

    await expect(handler.handle(job)).rejects.toThrow(
      `Document ${job.documentId} could not transition to ready`
    );
    expect(processingService.complete).not.toHaveBeenCalled();
  });

  it('throws when the claimed job cannot be completed', async () => {
    const processingService = createProcessingService(
      createProcessingJob(),
      null
    );
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(),
      parsingService: createParsingService(),
      processingService
    });

    await expect(handler.handle(job)).rejects.toThrow(
      `Processing job ${job.jobId} could not be completed`
    );
  });
});
