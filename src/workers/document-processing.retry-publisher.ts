import type { FastifyBaseLogger } from 'fastify';
import type {
  DocumentProcessingService,
  RepublishResult
} from '../modules/document-processing/index.js';

const DEFAULT_RETRY_PUBLISH_INTERVAL_MILLISECONDS = 5_000;

export interface DocumentProcessingRetryPublisherDependencies {
  service: Pick<
    DocumentProcessingService,
    'publishAvailableRetries' | 'publishRecoveredLeases'
  >;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  intervalMilliseconds?: number;
}

export interface RunningDocumentProcessingRetryPublisher {
  close(): Promise<void>;
}

function logPublishResult(
  log: DocumentProcessingRetryPublisherDependencies['log'],
  result: RepublishResult
): void {
  if (result.published > 0) {
    log.info(
      { publishedJobs: result.published },
      'Published available document processing retries'
    );
  }

  for (const failure of result.failures) {
    log.warn(
      { err: failure.error, jobId: failure.jobId },
      'Failed to publish document processing retry'
    );
  }
}

function logRecoveredLeaseResult(
  log: DocumentProcessingRetryPublisherDependencies['log'],
  result: RepublishResult
): void {
  if (result.published > 0) {
    log.info(
      { publishedJobs: result.published },
      'Published recovered document processing jobs'
    );
  }

  for (const failure of result.failures) {
    log.warn(
      { err: failure.error, jobId: failure.jobId },
      'Failed to publish recovered document processing job'
    );
  }
}

export async function startDocumentProcessingRetryPublisher({
  service,
  log,
  intervalMilliseconds = DEFAULT_RETRY_PUBLISH_INTERVAL_MILLISECONDS
}: DocumentProcessingRetryPublisherDependencies): Promise<RunningDocumentProcessingRetryPublisher> {
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds <= 0) {
    throw new Error('Retry publish interval must be a positive integer');
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCycle: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const publishAvailableRetries = async (): Promise<void> => {
    try {
      const result = await service.publishAvailableRetries();
      logPublishResult(log, result);
    } catch (error) {
      log.warn(
        { err: error },
        'Failed to query and publish available document processing retries'
      );
    }
  };

  const publishRecoveredLeases = async (): Promise<void> => {
    try {
      const result = await service.publishRecoveredLeases();
      logRecoveredLeaseResult(log, result);
    } catch (error) {
      log.warn(
        { err: error },
        'Failed to recover and publish expired document processing leases'
      );
    }
  };

  const publishRecoverableJobs = async (): Promise<void> => {
    await publishAvailableRetries();
    await publishRecoveredLeases();
  };

  const scheduleNextCycle = (): void => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      const cycle = publishRecoverableJobs();
      activeCycle = cycle;
      void cycle.then(() => {
        if (activeCycle === cycle) {
          activeCycle = undefined;
        }
        scheduleNextCycle();
      });
    }, intervalMilliseconds);
  };

  activeCycle = publishRecoverableJobs();
  await activeCycle;
  activeCycle = undefined;
  scheduleNextCycle();

  return {
    close() {
      closePromise ??= (async () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        await activeCycle;
      })();

      return closePromise;
    }
  };
}
