import { buffer } from 'node:stream/consumers';
import type { ProcessingDocumentsService } from '../documents/index.js';
import type { ParsingService } from '../parsing/index.js';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type { DocumentProcessingService } from './document-processing.service.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const PARSING_FAILURE_CODE = 'PARSING_FAILED';

export type ParseDocumentHandlerResult =
  | { outcome: 'processed'; processingJob: ProcessingJobRecord }
  | { outcome: 'skipped' };

export interface ParseDocumentHandler {
  handle(job: ParseDocumentJob): Promise<ParseDocumentHandlerResult>;
}

export interface ParseDocumentHandlerDependencies {
  documentsService: ProcessingDocumentsService;
  parsingService: Pick<ParsingService, 'extract'>;
  processingService: Pick<
    DocumentProcessingService,
    'claim' | 'complete' | 'fail'
  >;
}

async function recordParsingFailure(
  job: ParseDocumentJob,
  error: unknown,
  documentsService: ProcessingDocumentsService,
  processingService: Pick<DocumentProcessingService, 'fail'>
): Promise<never> {
  const cleanupErrors: unknown[] = [];

  try {
    const failedDocument = await documentsService.markDocumentFailed(
      job.documentId,
      PARSING_FAILURE_CODE
    );

    if (!failedDocument) {
      cleanupErrors.push(
        new Error(`Document ${job.documentId} could not transition to failed`)
      );
    }
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }

  try {
    const failedJob = await processingService.fail(job, PARSING_FAILURE_CODE);

    if (!failedJob) {
      cleanupErrors.push(
        new Error(`Processing job ${job.jobId} could not transition to failed`)
      );
    }
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [error, ...cleanupErrors],
      'Document parsing and failure recording both failed'
    );
  }

  throw error;
}

export function createParseDocumentHandler({
  documentsService,
  parsingService,
  processingService
}: ParseDocumentHandlerDependencies): ParseDocumentHandler {
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

      try {
        const { document, stream } =
          await documentsService.openDocumentForProcessing(job.documentId);
        const content = await buffer(stream);

        await parsingService.extract({
          documentId: job.documentId,
          mediaType: document.mediaType,
          content
        });
      } catch (error) {
        await recordParsingFailure(
          job,
          error,
          documentsService,
          processingService
        );
      }

      const readyDocument = await documentsService.markDocumentReady(
        job.documentId
      );

      if (!readyDocument) {
        throw new Error(
          `Document ${job.documentId} could not transition to ready`
        );
      }

      const completedJob = await processingService.complete(job);

      if (!completedJob) {
        throw new Error(`Processing job ${job.jobId} could not be completed`);
      }

      return { outcome: 'processed', processingJob: completedJob };
    }
  };
}
