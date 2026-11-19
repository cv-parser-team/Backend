import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseExecutor } from '../infrastructure/database/unit-of-work.js';
import type { ProcessingDocumentsService } from '../modules/documents/index.js';
import type { DocumentRecord } from '../modules/documents/documents.repository.js';
import type { CandidateExtractionResult } from '../modules/extraction/index.js';
import type {
  DocumentProcessingRepository,
  ProcessingJobRecord
} from '../modules/document-processing/document-processing.repository.js';
import { createDocumentProcessingService } from '../modules/document-processing/document-processing.service.js';
import {
  PARSE_DOCUMENT_QUEUE,
  createParseDocumentHandler
} from '../modules/document-processing/index.js';
import type { ParsingService } from '../modules/parsing/index.js';
import type { ExtractionRecord } from '../modules/parsing/parsing.repository.js';
import type { ExtractionResult } from '../modules/parsing/parsing.types.js';
import { createFakeMessageBroker } from '../testing/fake-message-broker.js';
import { startDocumentProcessingWorker } from './document-processing.worker.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const ownerUserId = '33333333-3333-4333-8333-333333333333';
const extractionId = '44444444-4444-4444-8444-444444444444';
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const documentBytes = Buffer.from('source document bytes');
const transaction = {} as DatabaseExecutor;

function createJobRepository(statuses: ProcessingJobRecord['status'][]) {
  let job: ProcessingJobRecord | undefined;

  const repository: DocumentProcessingRepository = {
    async createQueuedJob(createdDocumentId) {
      job = {
        jobId,
        documentId: createdDocumentId,
        status: 'queued',
        attemptCount: 0,
        failureCode: null,
        availableAt: timestamp,
        lockedUntil: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      statuses.push(job.status);
      return job;
    },
    async claimJob(input) {
      if (
        !job ||
        job.status !== 'queued' ||
        job.jobId !== input.jobId ||
        job.documentId !== input.documentId
      ) {
        return null;
      }

      job = {
        ...job,
        status: 'processing',
        attemptCount: job.attemptCount + 1,
        lockedUntil: new Date(timestamp.getTime() + input.leaseMilliseconds)
      };
      statuses.push(job.status);
      return job;
    },
    async lockClaimedJob(claim) {
      return job?.status === 'processing' &&
        job.jobId === claim.jobId &&
        job.attemptCount === claim.attemptCount
        ? job
        : null;
    },
    async completeJob(input) {
      if (
        !job ||
        job.status !== 'processing' ||
        job.jobId !== input.jobId ||
        job.documentId !== input.documentId
      ) {
        return null;
      }

      job = { ...job, status: 'completed', lockedUntil: null };
      statuses.push(job.status);
      return job;
    },
    async retryJob() {
      return null;
    },
    async releaseAvailableRetries() {
      return [];
    },
    async releaseExpiredLeases() {
      return [];
    },
    async failJob() {
      return null;
    },
    async listPublishableJobs() {
      return [];
    }
  };

  return repository;
}

function createDocument(status: DocumentRecord['status']): DocumentRecord {
  return {
    documentId,
    ownerUserId,
    purpose: 'source',
    originalFilename: 'resume.pdf',
    mediaType: 'application/pdf',
    byteSize: documentBytes.byteLength,
    sha256: 'a'.repeat(64),
    storageKey: 'documents/resume',
    status,
    failureCode: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createDocumentsService(statuses: DocumentRecord['status'][]) {
  let document = createDocument('stored');

  const service: ProcessingDocumentsService = {
    async markDocumentProcessing(requestedDocumentId) {
      if (
        requestedDocumentId !== document.documentId ||
        !['stored', 'processing'].includes(document.status)
      ) {
        return null;
      }

      document = createDocument('processing');
      statuses.push(document.status);
      return document;
    },
    async lockDocumentForProcessing(requestedDocumentId) {
      return requestedDocumentId === document.documentId ? document : null;
    },
    async markDocumentReady(requestedDocumentId) {
      if (
        requestedDocumentId !== document.documentId ||
        document.status !== 'processing'
      ) {
        return null;
      }

      document = createDocument('ready');
      statuses.push(document.status);
      return document;
    },
    async markDocumentFailed() {
      return null;
    },
    async openDocumentForProcessing(requestedDocumentId) {
      if (requestedDocumentId !== document.documentId) {
        throw new Error('Document not found');
      }

      return {
        document,
        stream: Readable.from(documentBytes)
      };
    }
  };

  return service;
}

describe('document processing pipeline', () => {
  it('processes a scheduled source document through the worker', async () => {
    const jobStatuses: ProcessingJobRecord['status'][] = [];
    const documentStatuses: DocumentRecord['status'][] = ['stored'];
    const broker = createFakeMessageBroker();
    const processingService = createDocumentProcessingService({
      broker,
      repository: createJobRepository(jobStatuses)
    });
    const extraction: ExtractionRecord = {
      extractionId,
      documentId,
      status: 'succeeded',
      format: 'pdf',
      pageCount: 1,
      content: { version: 3, pages: [], blocks: [] },
      failures: [],
      unmappedData: [],
      parserVersion: 'fake-parser',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const result: ExtractionResult = {
      status: 'succeeded',
      format: 'pdf',
      pageCount: 1,
      pages: [],
      blocks: [],
      failures: [],
      parserVersion: 'fake-parser'
    };
    const parser: Pick<ParsingService, 'parse' | 'saveExtraction'> = {
      parse: vi.fn().mockResolvedValue(result),
      saveExtraction: vi.fn().mockResolvedValue(extraction)
    };
    const candidateExtraction: CandidateExtractionResult = {
      invocationId: '55555555-5555-4555-8555-555555555555',
      version: 1,
      profile: { values: {}, rawValues: {}, confidence: {}, sources: {} },
      claims: [],
      reviewItems: [],
      unmapped: []
    };
    const candidateExtractionService = {
      extract: vi.fn().mockResolvedValue(candidateExtraction)
    };
    const extractionPersistenceCoordinator = {
      persist: vi.fn().mockResolvedValue([])
    };
    const handler = createParseDocumentHandler({
      documentsService: createDocumentsService(documentStatuses),
      parsingService: parser,
      candidateExtractionService,
      extractionPersistenceCoordinator,
      processingService,
      claimNormalizer: { normalizeClaim: vi.fn().mockResolvedValue(null) },
      logger: { warn: vi.fn() },
      unitOfWork: { run: (work) => work(transaction) }
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await startDocumentProcessingWorker({ broker, handler, log });
    const scheduledJob = await processingService.schedule(documentId);

    expect(Object.keys(scheduledJob)).toEqual([
      'version',
      'jobId',
      'documentId'
    ]);
    expect(broker.publishedMessages).toEqual([
      { queue: PARSE_DOCUMENT_QUEUE, message: scheduledJob }
    ]);

    await expect(
      broker.deliver(PARSE_DOCUMENT_QUEUE, scheduledJob)
    ).resolves.toBe('ack');

    expect(jobStatuses).toEqual(['queued', 'processing', 'completed']);
    expect(documentStatuses).toEqual(['stored', 'processing', 'ready']);
    expect(parser.parse).toHaveBeenCalledWith({
      mediaType: 'application/pdf',
      content: documentBytes
    });
    expect(parser.saveExtraction).toHaveBeenCalledWith(documentId, result, transaction);
    expect(candidateExtractionService.extract).toHaveBeenCalledWith({
      operationId: expect.any(String),
      input: ''
    });
    expect(extractionPersistenceCoordinator.persist).toHaveBeenCalledWith(
      {
        documentId,
        ownerUserId,
        result: candidateExtraction,
        sourceContent: result
      },
      transaction
    );
    expect(log.info).toHaveBeenLastCalledWith(
      { jobId, documentId, outcome: 'processed' },
      'Handled document processing job'
    );
  });
});
