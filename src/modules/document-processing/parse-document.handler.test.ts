import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseExecutor,
  UnitOfWork
} from '../../infrastructure/database/unit-of-work.js';
import type { ProcessingDocumentsService } from '../documents/index.js';
import type { DocumentRecord } from '../documents/documents.repository.js';
import {
  InvalidExtractionProvenanceError,
  SourceReferenceResolutionError,
  type CandidateExtractionResult,
  type CandidateExtractionService,
  type ExtractionPersistenceCoordinator
} from '../extraction/index.js';
import type { ParsingService } from '../parsing/index.js';
import type { ExtractionRecord } from '../parsing/parsing.repository.js';
import type { ExtractionResult } from '../parsing/parsing.types.js';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type { DocumentProcessingService } from './document-processing.service.js';
import {
  createParseDocumentHandler as createHandlerImplementation,
  type ParseDocumentHandlerDependencies
} from './parse-document.handler.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const job: ParseDocumentJob = {
  version: 1,
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222'
};
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const transaction = { name: 'transaction' } as unknown as DatabaseExecutor;

type ProcessingDouble = Pick<
  DocumentProcessingService,
  'claim' | 'lockClaim' | 'complete' | 'fail' | 'retry'
>;
type ParsingDouble = Pick<ParsingService, 'parse' | 'saveExtraction'>;

function createProcessingJob(
  status: ProcessingJobRecord['status'] = 'processing',
  attemptCount = 1
): ProcessingJobRecord {
  return {
    jobId: job.jobId,
    documentId: job.documentId,
    status,
    attemptCount,
    failureCode: status === 'failed' ? 'PARSING_FAILED' : null,
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
    failureCode: status === 'failed' ? 'PARSING_FAILED' : null,
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

function createResult(
  status: ExtractionResult['status'] = 'succeeded'
): ExtractionResult {
  return {
    status,
    format: 'pdf',
    pageCount: 1,
    pages: [],
    blocks: [],
    failures: [],
    parserVersion: 'test'
  };
}

function createCandidateExtractionResult(): CandidateExtractionResult {
  return {
    invocationId: '55555555-5555-4555-8555-555555555555',
    version: 1,
    profile: { values: {}, rawValues: {}, confidence: {}, sources: {} },
    claims: [],
    unmapped: []
  };
}

// Records every write so a test can check the order and that each write used
// the transaction.
function createRecorder() {
  const operations: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      operations.push(name);
      if (args.includes(transaction)) {
        operations.push(`${name}:in-transaction`);
      }
      return value;
    };
  return { operations, record };
}

function createUnitOfWork(operations: string[] = []): UnitOfWork {
  return {
    run: vi.fn(async (work) => {
      operations.push('begin');
      const result = await work(transaction);
      operations.push('commit');
      return result;
    })
  };
}

function createProcessingService(
  claimedJob: ProcessingJobRecord | null = createProcessingJob()
): ProcessingDouble {
  return {
    claim: vi.fn().mockResolvedValue(claimedJob),
    lockClaim: vi.fn().mockResolvedValue(claimedJob),
    complete: vi.fn().mockResolvedValue(createProcessingJob('completed')),
    retry: vi.fn().mockResolvedValue(createProcessingJob('retrying')),
    fail: vi.fn().mockResolvedValue(createProcessingJob('failed'))
  };
}

function createDocumentsService(
  overrides: Partial<ProcessingDocumentsService> = {}
): ProcessingDocumentsService {
  const processingDocument = createDocument('processing');

  return {
    markDocumentProcessing: vi.fn().mockResolvedValue(processingDocument),
    lockDocumentForProcessing: vi.fn().mockResolvedValue(processingDocument),
    openDocumentForProcessing: vi.fn(async () => ({
      document: processingDocument,
      stream: Readable.from('document bytes')
    })),
    markDocumentReady: vi.fn().mockResolvedValue(createDocument('ready')),
    markDocumentFailed: vi.fn().mockResolvedValue(createDocument('failed')),
    ...overrides
  };
}

function parsingThat(parse: ParsingDouble['parse']): ParsingDouble {
  return {
    parse,
    saveExtraction: vi.fn().mockResolvedValue(createExtraction())
  };
}

function createParsingService(): ParsingDouble {
  return parsingThat(vi.fn().mockResolvedValue(createResult()));
}

function failingParser(error = new Error('parser failed')): ParsingDouble {
  return parsingThat(vi.fn().mockRejectedValue(error));
}

type HandlerDependencies = Omit<
  ParseDocumentHandlerDependencies,
  'candidateExtractionService' | 'extractionPersistenceCoordinator'
> &
  Partial<
    Pick<
      ParseDocumentHandlerDependencies,
      'candidateExtractionService' | 'extractionPersistenceCoordinator'
    >
  >;

function createParseDocumentHandler(
  dependencies: HandlerDependencies
) {
  const {
    candidateExtractionService = {
      extract: vi
        .fn<CandidateExtractionService['extract']>()
        .mockResolvedValue(createCandidateExtractionResult())
    },
    extractionPersistenceCoordinator = {
      persist: vi
        .fn<ExtractionPersistenceCoordinator['persist']>()
        .mockResolvedValue([])
    },
    ...handlerDependencies
  } = dependencies;

  return createHandlerImplementation({
    ...handlerDependencies,
    candidateExtractionService,
    extractionPersistenceCoordinator
  });
}

describe('parse document handler', () => {
  it('parses outside the transaction and finishes inside it', async () => {
    const { operations, record } = createRecorder();
    const claimedJob = createProcessingJob();
    const completedJob = createProcessingJob('completed');
    const result = createResult();
    const processingService: ProcessingDouble = {
      claim: vi.fn(record('claim', claimedJob)),
      lockClaim: vi.fn(record('lock', claimedJob)),
      complete: vi.fn(record('complete', completedJob)),
      retry: vi.fn(),
      fail: vi.fn()
    };
    const documentsService = createDocumentsService({
      markDocumentProcessing: vi.fn(
        record('mark-processing', createDocument('processing'))
      ),
      markDocumentReady: vi.fn(record('mark-ready', createDocument('ready')))
    });
    const parsingService: ParsingDouble = {
      parse: vi.fn(record('parse', result)),
      saveExtraction: vi.fn(record('save', createExtraction()))
    };
    const candidateExtraction = createCandidateExtractionResult();
    const candidateExtractionService = {
      extract: vi.fn(record('extract', candidateExtraction))
    };
    const extractionPersistenceCoordinator = {
      persist: vi.fn(record('persist', []))
    };
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      candidateExtractionService,
      extractionPersistenceCoordinator,
      processingService,
      unitOfWork: createUnitOfWork(operations)
    });

    await expect(handler.handle(job)).resolves.toEqual({
      outcome: 'processed',
      processingJob: completedJob
    });
    expect(operations).toEqual([
      'claim',
      'mark-processing',
      'parse',
      'extract',
      'begin',
      'lock',
      'lock:in-transaction',
      'save',
      'save:in-transaction',
      'persist',
      'persist:in-transaction',
      'complete',
      'complete:in-transaction',
      'mark-ready',
      'mark-ready:in-transaction',
      'commit'
    ]);
    expect(parsingService.parse).toHaveBeenCalledWith({
      mediaType: 'application/pdf',
      content: Buffer.from('document bytes')
    });
    expect(parsingService.saveExtraction).toHaveBeenCalledWith(
      job.documentId,
      result,
      transaction
    );
    expect(candidateExtractionService.extract).toHaveBeenCalledWith({
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      input: ''
    });
    expect(extractionPersistenceCoordinator.persist).toHaveBeenCalledWith(
      {
        documentId: job.documentId,
        ownerUserId: createDocument('processing').ownerUserId,
        result: candidateExtraction,
        sourceContent: result
      },
      transaction
    );
    expect(processingService.lockClaim).toHaveBeenCalledWith(claimedJob, transaction);
    expect(processingService.complete).toHaveBeenCalledWith(claimedJob, transaction);
  });

  it('completes a partial extraction', async () => {
    const processingService = createProcessingService();
    const documentsService = createDocumentsService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService: parsingThat(vi.fn().mockResolvedValue(createResult('partial'))),
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toMatchObject({ outcome: 'processed' });
    expect(documentsService.markDocumentReady).toHaveBeenCalledWith(
      job.documentId,
      transaction
    );
    expect(processingService.retry).not.toHaveBeenCalled();
    expect(processingService.fail).not.toHaveBeenCalled();
  });

  it('retries without completion writes when candidate extraction fails', async () => {
    const failure = new Error('candidate extraction failed');
    const claimedJob = createProcessingJob();
    const retryingJob = createProcessingJob('retrying');
    const processingService = createProcessingService(claimedJob);
    processingService.retry = vi.fn().mockResolvedValue(retryingJob);
    const documentsService = createDocumentsService();
    const parsingService = createParsingService();
    const candidateExtractionService = {
      extract: vi
        .fn<CandidateExtractionService['extract']>()
        .mockRejectedValue(failure)
    };
    const extractionPersistenceCoordinator = {
      persist: vi.fn<ExtractionPersistenceCoordinator['persist']>()
    };
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      candidateExtractionService,
      extractionPersistenceCoordinator,
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toEqual({
      outcome: 'retrying',
      processingJob: retryingJob
    });
    expect(parsingService.saveExtraction).toHaveBeenCalledWith(
      job.documentId,
      createResult(),
      transaction
    );
    expect(processingService.retry).toHaveBeenCalledWith(
      claimedJob,
      'EXTRACTION_FAILED',
      transaction
    );
    expect(extractionPersistenceCoordinator.persist).not.toHaveBeenCalled();
    expect(processingService.complete).not.toHaveBeenCalled();
    expect(documentsService.markDocumentReady).not.toHaveBeenCalled();
  });

  it('records invalid extraction provenance as a permanent failure', async () => {
    const claimedJob = createProcessingJob();
    const failedJob = createProcessingJob('failed');
    const processingService = createProcessingService(claimedJob);
    processingService.fail = vi.fn().mockResolvedValue(failedJob);
    const documentsService = createDocumentsService();
    const parsingService = createParsingService();
    const provenanceError = new InvalidExtractionProvenanceError(
      new Error('conflicting physical anchors')
    );
    const extractionPersistenceCoordinator = {
      persist: vi
        .fn<ExtractionPersistenceCoordinator['persist']>()
        .mockRejectedValue(provenanceError)
    };
    const unitOfWork = createUnitOfWork();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      extractionPersistenceCoordinator,
      processingService,
      unitOfWork
    });

    await expect(handler.handle(job)).resolves.toEqual({
      outcome: 'failed',
      processingJob: failedJob
    });
    expect(unitOfWork.run).toHaveBeenCalledTimes(2);
    expect(parsingService.saveExtraction).toHaveBeenCalledTimes(2);
    expect(processingService.fail).toHaveBeenCalledWith(
      claimedJob,
      'INVALID_EXTRACTION_PROVENANCE',
      transaction
    );
    expect(documentsService.markDocumentFailed).toHaveBeenCalledWith(
      job.documentId,
      'INVALID_EXTRACTION_PROVENANCE',
      transaction
    );
    expect(processingService.retry).not.toHaveBeenCalled();
    expect(processingService.complete).not.toHaveBeenCalled();
    expect(documentsService.markDocumentReady).not.toHaveBeenCalled();
  });

  it('retries when AI source references cannot be resolved', async () => {
    const claimedJob = createProcessingJob();
    const retryingJob = createProcessingJob('retrying');
    const processingService = createProcessingService(claimedJob);
    processingService.retry = vi.fn().mockResolvedValue(retryingJob);
    const extractionPersistenceCoordinator = {
      persist: vi
        .fn<ExtractionPersistenceCoordinator['persist']>()
        .mockRejectedValue(new SourceReferenceResolutionError(['L99'], []))
    };
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(),
      parsingService: createParsingService(),
      extractionPersistenceCoordinator,
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toEqual({
      outcome: 'retrying',
      processingJob: retryingJob
    });
    expect(processingService.retry).toHaveBeenCalledWith(
      claimedJob,
      'EXTRACTION_FAILED',
      transaction
    );
    expect(processingService.complete).not.toHaveBeenCalled();
  });

  it('continues to propagate unknown persistence failures', async () => {
    const failure = new Error('database unavailable');
    const processingService = createProcessingService();
    const extractionPersistenceCoordinator = {
      persist: vi
        .fn<ExtractionPersistenceCoordinator['persist']>()
        .mockRejectedValue(failure)
    };
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(),
      parsingService: createParsingService(),
      extractionPersistenceCoordinator,
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).rejects.toBe(failure);
    expect(processingService.fail).not.toHaveBeenCalled();
    expect(processingService.retry).not.toHaveBeenCalled();
  });

  it('skips an unavailable delivery without touching the document', async () => {
    const processingService = createProcessingService(null);
    const documentsService = createDocumentsService();
    const parsingService = createParsingService();
    const unitOfWork = createUnitOfWork();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      processingService,
      unitOfWork
    });

    await expect(handler.handle(job)).resolves.toEqual({ outcome: 'skipped' });
    expect(documentsService.markDocumentProcessing).not.toHaveBeenCalled();
    expect(parsingService.parse).not.toHaveBeenCalled();
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('throws when a document that still exists cannot transition to processing', async () => {
    const parsingService = createParsingService();
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService({
        markDocumentProcessing: vi.fn().mockResolvedValue(null),
        lockDocumentForProcessing: vi.fn().mockResolvedValue(createDocument('ready'))
      }),
      parsingService,
      processingService: createProcessingService(),
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).rejects.toThrow(
      `Document ${job.documentId} could not transition to processing`
    );
    expect(parsingService.parse).not.toHaveBeenCalled();
  });

  describe('after too many attempts', () => {
    it('fails the job and the document without reading it again', async () => {
      const claimedJob = createProcessingJob('processing', 4);
      const failedJob = createProcessingJob('failed', 4);
      const processingService = createProcessingService(claimedJob);
      processingService.fail = vi.fn().mockResolvedValue(failedJob);
      const documentsService = createDocumentsService();
      const parsingService = createParsingService();
      const handler = createParseDocumentHandler({
        documentsService,
        parsingService,
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toEqual({
        outcome: 'failed',
        processingJob: failedJob
      });
      expect(processingService.fail).toHaveBeenCalledWith(
        claimedJob,
        'MAX_ATTEMPTS_EXCEEDED',
        transaction
      );
      expect(documentsService.markDocumentFailed).toHaveBeenCalledWith(
        job.documentId,
        'MAX_ATTEMPTS_EXCEEDED',
        transaction
      );
      expect(documentsService.openDocumentForProcessing).not.toHaveBeenCalled();
      expect(parsingService.parse).not.toHaveBeenCalled();
      expect(processingService.retry).not.toHaveBeenCalled();
    });

    it('still processes the last allowed attempt', async () => {
      const parsingService = createParsingService();
      const handler = createParseDocumentHandler({
        documentsService: createDocumentsService(),
        parsingService,
        processingService: createProcessingService(createProcessingJob('processing', 3)),
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toMatchObject({
        outcome: 'processed'
      });
      expect(parsingService.parse).toHaveBeenCalledOnce();
    });

    it('cancels instead when the document was deleted', async () => {
      const processingService = createProcessingService(
        createProcessingJob('processing', 4)
      );
      const documentsService = createDocumentsService({
        lockDocumentForProcessing: vi.fn().mockResolvedValue(null)
      });
      const handler = createParseDocumentHandler({
        documentsService,
        parsingService: createParsingService(),
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toMatchObject({
        outcome: 'cancelled'
      });
      expect(processingService.fail).toHaveBeenCalledWith(
        createProcessingJob('processing', 4),
        'DOCUMENT_DELETED',
        transaction
      );
      expect(documentsService.markDocumentFailed).not.toHaveBeenCalled();
    });

    it('does nothing when another attempt owns the job', async () => {
      const processingService = createProcessingService(
        createProcessingJob('processing', 4)
      );
      processingService.lockClaim = vi.fn().mockResolvedValue(null);
      const handler = createParseDocumentHandler({
        documentsService: createDocumentsService(),
        parsingService: createParsingService(),
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toEqual({ outcome: 'stale' });
      expect(processingService.fail).not.toHaveBeenCalled();
    });
  });

  describe('when the document is deleted', () => {
    const deletedDocuments = [
      ['gone', null],
      ['being deleted', createDocument('deleting')]
    ] as const;

    it.each(deletedDocuments)(
      'cancels the job before parsing when the document is %s',
      async (_state, lockedDocument) => {
        const processingService = createProcessingService();
        const cancelledJob = createProcessingJob('failed');
        processingService.fail = vi.fn().mockResolvedValue(cancelledJob);
        const parsingService = createParsingService();
        const handler = createParseDocumentHandler({
          documentsService: createDocumentsService({
            markDocumentProcessing: vi.fn().mockResolvedValue(null),
            lockDocumentForProcessing: vi.fn().mockResolvedValue(lockedDocument)
          }),
          parsingService,
          processingService,
          unitOfWork: createUnitOfWork()
        });

        await expect(handler.handle(job)).resolves.toEqual({
          outcome: 'cancelled',
          processingJob: cancelledJob
        });
        expect(processingService.fail).toHaveBeenCalledWith(
          createProcessingJob(),
          'DOCUMENT_DELETED',
          transaction
        );
        expect(parsingService.parse).not.toHaveBeenCalled();
      }
    );

    it.each(deletedDocuments)(
      'cancels the job without saving the result when the document is %s after parsing',
      async (_state, lockedDocument) => {
        const processingService = createProcessingService();
        const documentsService = createDocumentsService({
          lockDocumentForProcessing: vi.fn().mockResolvedValue(lockedDocument)
        });
        const parsingService = createParsingService();
        const handler = createParseDocumentHandler({
          documentsService,
          parsingService,
          processingService,
          unitOfWork: createUnitOfWork()
        });

        await expect(handler.handle(job)).resolves.toMatchObject({
          outcome: 'cancelled'
        });
        expect(documentsService.lockDocumentForProcessing).toHaveBeenCalledWith(
          job.documentId,
          transaction
        );
        expect(parsingService.saveExtraction).not.toHaveBeenCalled();
        expect(processingService.complete).not.toHaveBeenCalled();
        expect(documentsService.markDocumentReady).not.toHaveBeenCalled();
      }
    );

    it('cancels instead of failing the document at the attempt limit', async () => {
      const processingService = createProcessingService(
        createProcessingJob('processing', 3)
      );
      const documentsService = createDocumentsService({
        lockDocumentForProcessing: vi.fn().mockResolvedValue(null)
      });
      const handler = createParseDocumentHandler({
        documentsService,
        parsingService: failingParser(),
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toMatchObject({
        outcome: 'cancelled'
      });
      expect(processingService.fail).toHaveBeenCalledOnce();
      expect(processingService.fail).toHaveBeenCalledWith(
        createProcessingJob('processing', 3),
        'DOCUMENT_DELETED',
        transaction
      );
      expect(documentsService.markDocumentFailed).not.toHaveBeenCalled();
    });

    it('cancels instead of scheduling a retry', async () => {
      const processingService = createProcessingService();
      const handler = createParseDocumentHandler({
        documentsService: createDocumentsService({
          lockDocumentForProcessing: vi.fn().mockResolvedValue(null)
        }),
        parsingService: failingParser(),
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toMatchObject({
        outcome: 'cancelled'
      });
      expect(processingService.retry).not.toHaveBeenCalled();
    });

    it('does nothing when another attempt owns the job', async () => {
      const processingService = createProcessingService();
      processingService.lockClaim = vi.fn().mockResolvedValue(null);
      const documentsService = createDocumentsService({
        markDocumentProcessing: vi.fn().mockResolvedValue(null)
      });
      const handler = createParseDocumentHandler({
        documentsService,
        parsingService: createParsingService(),
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toEqual({ outcome: 'stale' });
      expect(documentsService.lockDocumentForProcessing).not.toHaveBeenCalled();
      expect(processingService.fail).not.toHaveBeenCalled();
    });
  });

  it('saves nothing when another attempt owns the job', async () => {
    const processingService = createProcessingService();
    processingService.lockClaim = vi.fn().mockResolvedValue(null);
    const documentsService = createDocumentsService();
    const parsingService = createParsingService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService,
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toEqual({ outcome: 'stale' });
    expect(parsingService.saveExtraction).not.toHaveBeenCalled();
    expect(processingService.complete).not.toHaveBeenCalled();
    expect(documentsService.markDocumentReady).not.toHaveBeenCalled();
  });

  it('rolls everything back when the document cannot transition to ready', async () => {
    const operations: string[] = [];
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService({
        markDocumentReady: vi.fn().mockResolvedValue(null)
      }),
      parsingService: createParsingService(),
      processingService: createProcessingService(),
      unitOfWork: createUnitOfWork(operations)
    });

    await expect(handler.handle(job)).rejects.toThrow(
      `Document ${job.documentId} could not transition to ready`
    );
    // The error leaves the transaction, so it rolls back instead of committing.
    expect(operations).toEqual(['begin']);
  });

  it('rolls back when the locked job cannot be completed', async () => {
    const processingService = createProcessingService();
    processingService.complete = vi.fn().mockResolvedValue(null);
    const documentsService = createDocumentsService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService: createParsingService(),
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).rejects.toThrow(
      `Processing job ${job.jobId} could not be completed`
    );
    expect(documentsService.markDocumentReady).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    'schedules a retry in the transaction on attempt %i',
    async (attemptCount) => {
      const claimedJob = createProcessingJob('processing', attemptCount);
      const retryingJob = createProcessingJob('retrying', attemptCount);
      const processingService = createProcessingService(claimedJob);
      processingService.retry = vi.fn().mockResolvedValue(retryingJob);
      const documentsService = createDocumentsService();
      const parsingService = failingParser();
      const handler = createParseDocumentHandler({
        documentsService,
        parsingService,
        processingService,
        unitOfWork: createUnitOfWork()
      });

      await expect(handler.handle(job)).resolves.toEqual({
        outcome: 'retrying',
        processingJob: retryingJob
      });
      expect(processingService.retry).toHaveBeenCalledWith(
        claimedJob,
        'PARSING_FAILED',
        transaction
      );
      expect(parsingService.saveExtraction).not.toHaveBeenCalled();
      expect(documentsService.markDocumentFailed).not.toHaveBeenCalled();
      expect(processingService.fail).not.toHaveBeenCalled();
      expect(processingService.complete).not.toHaveBeenCalled();
    }
  );

  it('keeps a failed extraction and schedules a retry in one transaction', async () => {
    const failedResult = createResult('failed');
    const processingService = createProcessingService();
    const parsingService = parsingThat(vi.fn().mockResolvedValue(failedResult));
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(),
      parsingService,
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toMatchObject({ outcome: 'retrying' });
    expect(parsingService.saveExtraction).toHaveBeenCalledWith(
      job.documentId,
      failedResult,
      transaction
    );
    expect(processingService.retry).toHaveBeenCalledWith(
      createProcessingJob(),
      'PARSING_FAILED',
      transaction
    );
  });

  it('fails the job, then the document, in one transaction at the attempt limit', async () => {
    const { operations, record } = createRecorder();
    const claimedJob = createProcessingJob('processing', 3);
    const failedJob = createProcessingJob('failed', 3);
    const processingService = createProcessingService(claimedJob);
    processingService.fail = vi.fn(record('fail-job', failedJob));
    const documentsService = createDocumentsService({
      markDocumentFailed: vi.fn(record('mark-failed', createDocument('failed')))
    });
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService: failingParser(),
      processingService,
      unitOfWork: createUnitOfWork(operations)
    });

    await expect(handler.handle(job)).resolves.toEqual({
      outcome: 'failed',
      processingJob: failedJob
    });
    expect(operations).toEqual([
      'begin',
      'fail-job',
      'fail-job:in-transaction',
      'mark-failed',
      'mark-failed:in-transaction',
      'commit'
    ]);
    expect(documentsService.markDocumentFailed).toHaveBeenCalledWith(
      job.documentId,
      'PARSING_FAILED',
      transaction
    );
    expect(processingService.retry).not.toHaveBeenCalled();
  });

  it('records a storage-open failure without invoking the parser', async () => {
    const processingService = createProcessingService(
      createProcessingJob('processing', 3)
    );
    const parsingService = createParsingService();
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService({
        openDocumentForProcessing: vi
          .fn()
          .mockRejectedValue(new Error('storage unavailable'))
      }),
      parsingService,
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toMatchObject({ outcome: 'failed' });
    expect(parsingService.parse).not.toHaveBeenCalled();
  });

  it('fails nothing when another attempt owns the job', async () => {
    const processingService = createProcessingService(
      createProcessingJob('processing', 3)
    );
    processingService.lockClaim = vi.fn().mockResolvedValue(null);
    const documentsService = createDocumentsService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService: failingParser(),
      processingService,
      unitOfWork: createUnitOfWork()
    });

    await expect(handler.handle(job)).resolves.toEqual({ outcome: 'stale' });
    expect(processingService.fail).not.toHaveBeenCalled();
    expect(processingService.retry).not.toHaveBeenCalled();
    expect(documentsService.markDocumentFailed).not.toHaveBeenCalled();
  });

  it('aggregates parsing and job-failure errors', async () => {
    const parsingError = new Error('parser failed');
    const jobFailureError = new Error('job failure update failed');
    const processingService = createProcessingService(
      createProcessingJob('processing', 3)
    );
    processingService.fail = vi.fn().mockRejectedValue(jobFailureError);
    const documentsService = createDocumentsService();
    const handler = createParseDocumentHandler({
      documentsService,
      parsingService: failingParser(parsingError),
      processingService,
      unitOfWork: createUnitOfWork()
    });

    const error = await handler.handle(job).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'Document parsing and failure recording both failed'
    );
    expect((error as AggregateError).errors).toEqual([parsingError, jobFailureError]);
    expect(documentsService.markDocumentFailed).not.toHaveBeenCalled();
  });

  it('aggregates parsing and document-failure errors', async () => {
    const parsingError = new Error('parser failed');
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService({
        markDocumentFailed: vi.fn().mockResolvedValue(null)
      }),
      parsingService: failingParser(parsingError),
      processingService: createProcessingService(createProcessingJob('processing', 3)),
      unitOfWork: createUnitOfWork()
    });

    const error = await handler.handle(job).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      parsingError,
      new Error(`Document ${job.documentId} could not transition to failed`)
    ]);
  });

  it('aggregates parsing and retry-scheduling errors', async () => {
    const parsingError = new Error('parser failed');
    const retryError = new Error('retry update failed');
    const processingService = createProcessingService();
    processingService.retry = vi.fn().mockRejectedValue(retryError);
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(),
      parsingService: failingParser(parsingError),
      processingService,
      unitOfWork: createUnitOfWork()
    });

    const error = await handler.handle(job).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(
      'Document parsing and retry scheduling both failed'
    );
    expect((error as AggregateError).errors).toEqual([parsingError, retryError]);
  });

  it('rolls back when the locked job cannot move to retrying', async () => {
    const parsingError = new Error('parser failed');
    const processingService = createProcessingService();
    processingService.retry = vi.fn().mockResolvedValue(null);
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(),
      parsingService: failingParser(parsingError),
      processingService,
      unitOfWork: createUnitOfWork()
    });

    const error = await handler.handle(job).catch((caught: unknown) => caught);

    expect((error as AggregateError).errors).toEqual([
      parsingError,
      new Error(`Processing job ${job.jobId} could not transition to retrying`)
    ]);
  });
});
