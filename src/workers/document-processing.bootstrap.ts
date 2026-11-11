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
  app: DocumentProcessingWorkerApp
): Promise<RunningDocumentProcessingWorker> {
  let retryPublisher: RunningDocumentProcessingRetryPublisher | undefined;

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
  } catch (error) {
    const cleanupErrors: unknown[] = [];

    try {
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
        await retryPublisher?.close();
        await app.close();
      })();
      return closePromise;
    }
  };
}
