import { buffer } from 'node:stream/consumers';
import type { UnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import type { ProcessingDocumentsService } from '../documents/index.js';
import type { ParsingService } from '../parsing/index.js';
import type { ExtractionResult } from '../parsing/parsing.types.js';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type { DocumentProcessingService } from './document-processing.service.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const PARSING_FAILURE_CODE = 'PARSING_FAILED';
const MAX_PROCESSING_ATTEMPTS = 3;

// `stale`: the lease expired and another worker claimed the job, so this
// attempt stopped without saving anything.
export type ParseDocumentHandlerResult =
  | { outcome: 'processed'; processingJob: ProcessingJobRecord }
  | { outcome: 'retrying'; processingJob: ProcessingJobRecord }
  | { outcome: 'failed'; processingJob: ProcessingJobRecord }
  | { outcome: 'skipped' }
  | { outcome: 'stale' };

export interface ParseDocumentHandler {
  handle(job: ParseDocumentJob): Promise<ParseDocumentHandlerResult>;
}

export interface ParseDocumentHandlerDependencies {
  documentsService: ProcessingDocumentsService;
  parsingService: Pick<ParsingService, 'parse' | 'saveExtraction'>;
  processingService: Pick<
    DocumentProcessingService,
    'claim' | 'lockClaim' | 'complete' | 'fail' | 'retry'
  >;
  unitOfWork: UnitOfWork;
}

const STALE: ParseDocumentHandlerResult = { outcome: 'stale' };

// The document is read and parsed outside any transaction. The attempt then
// ends in one transaction that first locks the job under this claim: the
// result, the job, and the document change together, or not at all, and an
// attempt that no longer owns the job changes nothing.
export function createParseDocumentHandler({
  documentsService,
  parsingService,
  processingService,
  unitOfWork
}: ParseDocumentHandlerDependencies): ParseDocumentHandler {
  async function finishParsed(
    processingJob: ProcessingJobRecord,
    extraction: ExtractionResult
  ): Promise<ParseDocumentHandlerResult> {
    return unitOfWork.run(async (transaction) => {
      if (!(await processingService.lockClaim(processingJob, transaction))) {
        return STALE;
      }

      await parsingService.saveExtraction(
        processingJob.documentId,
        extraction,
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

  // `extraction` is set when the parser returned a failed result, which is
  // kept like any other result.
  async function finishFailed(
    processingJob: ProcessingJobRecord,
    error: unknown,
    extraction: ExtractionResult | null
  ): Promise<ParseDocumentHandlerResult> {
    const retrying = processingJob.attemptCount < MAX_PROCESSING_ATTEMPTS;

    try {
      return await unitOfWork.run(async (transaction) => {
        if (!(await processingService.lockClaim(processingJob, transaction))) {
          return STALE;
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
            PARSING_FAILURE_CODE,
            transaction
          );
          if (!retryingJob) {
            throw new Error(
              `Processing job ${processingJob.jobId} could not transition to retrying`
            );
          }
          return { outcome: 'retrying', processingJob: retryingJob };
        }

        const failedJob = await processingService.fail(
          processingJob,
          PARSING_FAILURE_CODE,
          transaction
        );
        if (!failedJob) {
          throw new Error(
            `Processing job ${processingJob.jobId} could not transition to failed`
          );
        }

        const failedDocument = await documentsService.markDocumentFailed(
          processingJob.documentId,
          PARSING_FAILURE_CODE,
          transaction
        );
        if (!failedDocument) {
          throw new Error(
            `Document ${processingJob.documentId} could not transition to failed`
          );
        }

        return { outcome: 'failed', processingJob: failedJob };
      });
    } catch (recordingError) {
      throw new AggregateError(
        [error, recordingError],
        retrying
          ? 'Document parsing and retry scheduling both failed'
          : 'Document parsing and failure recording both failed'
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
        throw new Error(
          `Document ${job.documentId} could not transition to processing`
        );
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

      return finishParsed(processingJob, extraction);
    }
  };
}
