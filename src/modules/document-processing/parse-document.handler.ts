import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import type {
  DatabaseExecutor,
  UnitOfWork
} from '../../infrastructure/database/unit-of-work.js';
import type { ProcessingDocumentsService } from '../documents/index.js';
import {
  InvalidExtractionProvenanceError,
  SourceReferenceResolutionError,
  type CandidateExtractionResult,
  type CandidateExtractionService,
  type ExtractionPersistenceCoordinator
} from '../extraction/index.js';
import { buildAiInput, type ParsingService } from '../parsing/index.js';
import type { ExtractionResult } from '../parsing/parsing.types.js';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type { DocumentProcessingService } from './document-processing.service.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const PARSING_FAILURE_CODE = 'PARSING_FAILED';
const EXTRACTION_FAILURE_CODE = 'EXTRACTION_FAILED';
const INVALID_EXTRACTION_PROVENANCE_FAILURE_CODE =
  'INVALID_EXTRACTION_PROVENANCE';
const DOCUMENT_DELETED_FAILURE_CODE = 'DOCUMENT_DELETED';
const MAX_ATTEMPTS_FAILURE_CODE = 'MAX_ATTEMPTS_EXCEEDED';
const MAX_PROCESSING_ATTEMPTS = 3;

// `stale`: the lease expired and another worker claimed the job, so this
// attempt stopped without saving anything.
// `cancelled`: the document was deleted, so the job was failed without retry.
export type ParseDocumentHandlerResult =
  | { outcome: 'processed'; processingJob: ProcessingJobRecord }
  | { outcome: 'retrying'; processingJob: ProcessingJobRecord }
  | { outcome: 'failed'; processingJob: ProcessingJobRecord }
  | { outcome: 'cancelled'; processingJob: ProcessingJobRecord }
  | { outcome: 'skipped' }
  | { outcome: 'stale' };

export interface ParseDocumentHandler {
  handle(job: ParseDocumentJob): Promise<ParseDocumentHandlerResult>;
}

export interface ParseDocumentHandlerDependencies {
  documentsService: ProcessingDocumentsService;
  parsingService: Pick<ParsingService, 'parse' | 'saveExtraction'>;
  candidateExtractionService: Pick<CandidateExtractionService, 'extract'>;
  extractionPersistenceCoordinator: Pick<
    ExtractionPersistenceCoordinator,
    'persist'
  >;
  processingService: Pick<
    DocumentProcessingService,
    'claim' | 'lockClaim' | 'complete' | 'fail' | 'retry'
  >;
  unitOfWork: UnitOfWork;
}

const STALE: ParseDocumentHandlerResult = { outcome: 'stale' };

function extractionOperationId(processingJob: ProcessingJobRecord): string {
  // A stable UUID distinguishes retries while linking the invocation to one
  // claimed processing attempt.
  const hash = createHash('sha256')
    .update(processingJob.jobId)
    .update(':')
    .update(String(processingJob.attemptCount))
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32)
  ].join('-');
}

// The document is read and parsed outside any transaction. The attempt then
// ends in one transaction that first locks the job under this claim: the
// result, the job, and the document change together, or not at all, and an
// attempt that no longer owns the job changes nothing.
export function createParseDocumentHandler({
  documentsService,
  parsingService,
  candidateExtractionService,
  extractionPersistenceCoordinator,
  processingService,
  unitOfWork
}: ParseDocumentHandlerDependencies): ParseDocumentHandler {
  // Runs after the job is locked. The document is locked as well, so a delete
  // waits for this attempt; a document that is gone or being deleted ends the
  // job for good instead of letting it be retried forever.
  async function cancelIfDocumentDeleted(
    processingJob: ProcessingJobRecord,
    transaction: DatabaseExecutor
  ): Promise<ParseDocumentHandlerResult | null> {
    const document = await documentsService.lockDocumentForProcessing(
      processingJob.documentId,
      transaction
    );
    if (document && document.status !== 'deleting') {
      return null;
    }

    const failedJob = await processingService.fail(
      processingJob,
      DOCUMENT_DELETED_FAILURE_CODE,
      transaction
    );
    if (!failedJob) {
      throw new Error(
        `Processing job ${processingJob.jobId} could not transition to failed`
      );
    }

    return { outcome: 'cancelled', processingJob: failedJob };
  }

  // Called when the document could not move to processing: ends the job if
  // the document was deleted, and reports any other state as an error.
  async function cancelUnprocessable(
    processingJob: ProcessingJobRecord
  ): Promise<ParseDocumentHandlerResult> {
    return unitOfWork.run(async (transaction) => {
      if (!(await processingService.lockClaim(processingJob, transaction))) {
        return STALE;
      }

      const cancelled = await cancelIfDocumentDeleted(processingJob, transaction);
      if (cancelled) {
        return cancelled;
      }

      throw new Error(
        `Document ${processingJob.documentId} could not transition to processing`
      );
    });
  }

  async function finishParsed(
    processingJob: ProcessingJobRecord,
    extraction: ExtractionResult,
    candidateExtraction: CandidateExtractionResult,
    ownerUserId: string
  ): Promise<ParseDocumentHandlerResult> {
    return unitOfWork.run(async (transaction) => {
      if (!(await processingService.lockClaim(processingJob, transaction))) {
        return STALE;
      }

      const cancelled = await cancelIfDocumentDeleted(processingJob, transaction);
      if (cancelled) {
        return cancelled;
      }

      await parsingService.saveExtraction(
        processingJob.documentId,
        extraction,
        transaction
      );
      await extractionPersistenceCoordinator.persist(
        {
          documentId: processingJob.documentId,
          ownerUserId,
          result: candidateExtraction,
          sourceContent: extraction
        },
        transaction
      );

      const completedJob = await processingService.complete(
        processingJob,
        transaction
      );
      if (!completedJob) {
        throw new Error(
          `Processing job ${processingJob.jobId} could not be completed`
        );
      }

      const readyDocument = await documentsService.markDocumentReady(
        processingJob.documentId,
        transaction
      );
      if (!readyDocument) {
        throw new Error(
          `Document ${processingJob.documentId} could not transition to ready`
        );
      }

      return { outcome: 'processed', processingJob: completedJob };
    });
  }

  // Ends the job and the document as failed for good, in the caller's
  // transaction, after the job and the document were locked.
  async function failJobAndDocument(
    processingJob: ProcessingJobRecord,
    failureCode: string,
    transaction: DatabaseExecutor
  ): Promise<ParseDocumentHandlerResult> {
    const failedJob = await processingService.fail(
      processingJob,
      failureCode,
      transaction
    );
    if (!failedJob) {
      throw new Error(
        `Processing job ${processingJob.jobId} could not transition to failed`
      );
    }

    const failedDocument = await documentsService.markDocumentFailed(
      processingJob.documentId,
      failureCode,
      transaction
    );
    if (!failedDocument) {
      throw new Error(
        `Document ${processingJob.documentId} could not transition to failed`
      );
    }

    return { outcome: 'failed', processingJob: failedJob };
  }

  // A worker that keeps crashing never reaches the retry logic, while every
  // lease recovery adds an attempt. Such a job is failed before the document
  // is read again.
  async function failExhausted(
    processingJob: ProcessingJobRecord
  ): Promise<ParseDocumentHandlerResult> {
    return unitOfWork.run(async (transaction) => {
      if (!(await processingService.lockClaim(processingJob, transaction))) {
        return STALE;
      }

      const cancelled = await cancelIfDocumentDeleted(processingJob, transaction);
      if (cancelled) {
        return cancelled;
      }

      return failJobAndDocument(
        processingJob,
        MAX_ATTEMPTS_FAILURE_CODE,
        transaction
      );
    });
  }

  // `extraction` is set when the parser returned a failed result, which is
  // kept like any other result.
  async function finishFailed(
    processingJob: ProcessingJobRecord,
    error: unknown,
    extraction: ExtractionResult | null,
    failureCode = PARSING_FAILURE_CODE,
    failureLabel = 'Document parsing'
  ): Promise<ParseDocumentHandlerResult> {
    const retrying = processingJob.attemptCount < MAX_PROCESSING_ATTEMPTS;

    try {
      return await unitOfWork.run(async (transaction) => {
        if (!(await processingService.lockClaim(processingJob, transaction))) {
          return STALE;
        }

        const cancelled = await cancelIfDocumentDeleted(
          processingJob,
          transaction
        );
        if (cancelled) {
          return cancelled;
        }

        if (extraction) {
          await parsingService.saveExtraction(
            processingJob.documentId,
            extraction,
            transaction
          );
        }

        if (retrying) {
          const retryingJob = await processingService.retry(
            processingJob,
            failureCode,
            transaction
          );
          if (!retryingJob) {
            throw new Error(
              `Processing job ${processingJob.jobId} could not transition to retrying`
            );
          }
          return { outcome: 'retrying', processingJob: retryingJob };
        }

        return failJobAndDocument(
          processingJob,
          failureCode,
          transaction
        );
      });
    } catch (recordingError) {
      throw new AggregateError(
        [error, recordingError],
        retrying
          ? `${failureLabel} and retry scheduling both failed`
          : `${failureLabel} and failure recording both failed`
      );
    }
  }

  async function finishInvalidExtractionProvenance(
    processingJob: ProcessingJobRecord,
    error: InvalidExtractionProvenanceError,
    extraction: ExtractionResult
  ): Promise<ParseDocumentHandlerResult> {
    try {
      return await unitOfWork.run(async (transaction) => {
        if (!(await processingService.lockClaim(processingJob, transaction))) {
          return STALE;
        }

        const cancelled = await cancelIfDocumentDeleted(
          processingJob,
          transaction
        );
        if (cancelled) {
          return cancelled;
        }

        await parsingService.saveExtraction(
          processingJob.documentId,
          extraction,
          transaction
        );
        return failJobAndDocument(
          processingJob,
          INVALID_EXTRACTION_PROVENANCE_FAILURE_CODE,
          transaction
        );
      });
    } catch (recordingError) {
      throw new AggregateError(
        [error, recordingError],
        'Invalid extraction provenance and failure recording both failed'
      );
    }
  }

  return {
    async handle(job) {
      const processingJob = await processingService.claim(job);

      if (!processingJob) {
        return { outcome: 'skipped' };
      }

      const processingDocument =
        await documentsService.markDocumentProcessing(job.documentId);

      if (!processingDocument) {
        return cancelUnprocessable(processingJob);
      }

      if (processingJob.attemptCount > MAX_PROCESSING_ATTEMPTS) {
        return failExhausted(processingJob);
      }

      let extraction: ExtractionResult;

      try {
        const { document, stream } =
          await documentsService.openDocumentForProcessing(job.documentId);
        const content = await buffer(stream);

        extraction = await parsingService.parse({
          mediaType: document.mediaType,
          content
        });
      } catch (error) {
        return finishFailed(processingJob, error, null);
      }

      if (extraction.status === 'failed') {
        return finishFailed(
          processingJob,
          new Error(
            `Parsing produced a failed extraction for document ${job.documentId}`
          ),
          extraction
        );
      }

      let candidateExtraction: CandidateExtractionResult;
      try {
        candidateExtraction = await candidateExtractionService.extract({
          operationId: extractionOperationId(processingJob),
          input: buildAiInput(extraction)
        });
      } catch (error) {
        return finishFailed(
          processingJob,
          error,
          extraction,
          EXTRACTION_FAILURE_CODE,
          'Candidate extraction'
        );
      }

      try {
        return await finishParsed(
          processingJob,
          extraction,
          candidateExtraction,
          processingDocument.ownerUserId
        );
      } catch (error) {
        if (error instanceof InvalidExtractionProvenanceError) {
          return finishInvalidExtractionProvenance(
            processingJob,
            error,
            extraction
          );
        }
        if (error instanceof SourceReferenceResolutionError) {
          return finishFailed(
            processingJob,
            error,
            extraction,
            EXTRACTION_FAILURE_CODE,
            'Candidate extraction persistence'
          );
        }
        throw error;
      }
    }
  };
}
