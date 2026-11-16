import type { FastifyBaseLogger } from 'fastify';
import type { ManagedMessageBroker } from '../infrastructure/messaging/message-broker.js';
import type {
  DocumentProcessingService,
  ParseDocumentHandler,
  RepublishResult
} from '../modules/document-processing/index.js';
import {
  startDocumentProcessingRetryPublisher,
  type RunningDocumentProcessingRetryPublisher
} from './document-processing.retry-publisher.js';
import { startDocumentProcessingWorker } from './document-processing.worker.js';
import type { NormalizationAi } from '../modules/normalization/index.js';
import {
  startNormalizationAiWorker,
  type RunningNormalizationAiWorker
} from './normalization-ai.worker.js';

export interface NormalizationAiWorkerOptions {
  intervalMilliseconds: number;
  batchSize: number;
}

export interface DocumentProcessingWorkerApp {
  documentProcessingService: Pick<
    DocumentProcessingService,
    | 'publishAvailableRetries'
    | 'publishRecoveredLeases'
    | 'republishQueuedJobs'
  >;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  messageBroker: Pick<ManagedMessageBroker, 'consume'>;
  parseDocumentHandler: Pick<ParseDocumentHandler, 'handle'>;
  normalizationAi?: Pick<NormalizationAi, 'enabled' | 'requests' | 'processor'>;
  ready(): PromiseLike<void>;
  close(): Promise<void>;
}

function logRepublishResult(
  log: DocumentProcessingWorkerApp['log'],
  result: RepublishResult
): void {
  if (result.published > 0) {
    log.info(
      { publishedJobs: result.published },
      'Republished queued document processing jobs'
    );
  }

  for (const failure of result.failures) {
    log.warn(
      { err: failure.error, jobId: failure.jobId },
      'Failed to republish queued document processing job'
    );
  }
}

export interface RunningDocumentProcessingWorker {
  close(): Promise<void>;
}

export async function bootstrapDocumentProcessingWorker(
  app: DocumentProcessingWorkerApp,
  normalizationAiOptions?: NormalizationAiWorkerOptions
): Promise<RunningDocumentProcessingWorker> {
  let retryPublisher: RunningDocumentProcessingRetryPublisher | undefined;
  let normalizationAiWorker: RunningNormalizationAiWorker | undefined;

  try {
    await app.ready();
    const republishResult =
      await app.documentProcessingService.republishQueuedJobs();
    logRepublishResult(app.log, republishResult);
    retryPublisher = await startDocumentProcessingRetryPublisher({
      service: app.documentProcessingService,
      log: app.log
    });
    await startDocumentProcessingWorker({
      broker: app.messageBroker,
      handler: app.parseDocumentHandler,
      log: app.log
    });
    if (app.normalizationAi?.enabled && normalizationAiOptions) {
      normalizationAiWorker = startNormalizationAiWorker({
        normalizationAi: app.normalizationAi,
        log: app.log,
        ...normalizationAiOptions
      });
      app.log.info('Normalization AI worker started');
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];

    try {
      await normalizationAiWorker?.close();
      await retryPublisher?.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }

    try {
      await app.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Document processing worker startup and cleanup both failed'
      );
    }

    throw error;
  }

  let closePromise: Promise<void> | undefined;

  return {
    close() {
      closePromise ??= (async () => {
        await normalizationAiWorker?.close();
        await retryPublisher?.close();
        await app.close();
      })();
      return closePromise;
    }
  };
}
