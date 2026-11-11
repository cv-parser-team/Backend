import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentProcessingService,
  RepublishResult
} from '../modules/document-processing/index.js';
import { startDocumentProcessingRetryPublisher } from './document-processing.retry-publisher.js';

const intervalMilliseconds = 5_000;
const emptyResult: RepublishResult = { published: 0, failures: [] };

function createDependencies() {
  return {
    service: {
      publishAvailableRetries: vi.fn(async () => emptyResult),
      publishRecoveredLeases: vi.fn(async () => emptyResult)
    } satisfies Pick<
      DocumentProcessingService,
      'publishAvailableRetries' | 'publishRecoveredLeases'
    >,
    log: {
      info: vi.fn(),
      warn: vi.fn()
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('document processing retry publisher', () => {
  it('publishes immediately, logs results, and repeats after the interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dependencies = createDependencies();
    const publicationError = new Error('RabbitMQ unavailable');
    dependencies.service.publishAvailableRetries.mockResolvedValueOnce({
      published: 1,
      failures: [{ jobId: 'job-2', error: publicationError }]
    });

    const publisher = await startDocumentProcessingRetryPublisher({
      ...dependencies,
      intervalMilliseconds
    });

    expect(dependencies.service.publishAvailableRetries).toHaveBeenCalledOnce();
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledOnce();
    expect(dependencies.log.info).toHaveBeenCalledWith(
      { publishedJobs: 1 },
      'Published available document processing retries'
    );
    expect(dependencies.log.warn).toHaveBeenCalledWith(
      { err: publicationError, jobId: 'job-2' },
      'Failed to publish document processing retry'
    );

    await vi.advanceTimersByTimeAsync(intervalMilliseconds);
    expect(dependencies.service.publishAvailableRetries).toHaveBeenCalledTimes(2);
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledTimes(2);
    await publisher.close();
  });

  it('does not overlap publication cycles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dependencies = createDependencies();
    const pendingCycle = deferred<typeof emptyResult>();
    dependencies.service.publishAvailableRetries
      .mockResolvedValueOnce(emptyResult)
      .mockReturnValueOnce(pendingCycle.promise);

    const publisher = await startDocumentProcessingRetryPublisher({
      ...dependencies,
      intervalMilliseconds
    });

    await vi.advanceTimersByTimeAsync(intervalMilliseconds);
    await vi.advanceTimersByTimeAsync(intervalMilliseconds * 2);
    expect(dependencies.service.publishAvailableRetries).toHaveBeenCalledTimes(2);
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledOnce();

    pendingCycle.resolve(emptyResult);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(intervalMilliseconds);
    expect(dependencies.service.publishAvailableRetries).toHaveBeenCalledTimes(3);
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledTimes(3);
    await publisher.close();
  });

  it('logs polling errors and continues with the next cycle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dependencies = createDependencies();
    const pollingError = new Error('database unavailable');
    dependencies.service.publishAvailableRetries.mockRejectedValueOnce(
      pollingError
    );

    const publisher = await startDocumentProcessingRetryPublisher({
      ...dependencies,
      intervalMilliseconds
    });

    expect(dependencies.log.warn).toHaveBeenCalledWith(
      { err: pollingError },
      'Failed to query and publish available document processing retries'
    );
    await vi.advanceTimersByTimeAsync(intervalMilliseconds);
    expect(dependencies.service.publishAvailableRetries).toHaveBeenCalledTimes(2);
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledTimes(2);
    await publisher.close();
  });

  it('logs recovered lease results and continues after recovery errors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dependencies = createDependencies();
    const publicationError = new Error('RabbitMQ unavailable');
    const recoveryError = new Error('database unavailable');
    dependencies.service.publishRecoveredLeases
      .mockResolvedValueOnce({
        published: 1,
        failures: [{ jobId: 'job-2', error: publicationError }]
      })
      .mockRejectedValueOnce(recoveryError);

    const publisher = await startDocumentProcessingRetryPublisher({
      ...dependencies,
      intervalMilliseconds
    });

    expect(dependencies.log.info).toHaveBeenCalledWith(
      { publishedJobs: 1 },
      'Published recovered document processing jobs'
    );
    expect(dependencies.log.warn).toHaveBeenCalledWith(
      { err: publicationError, jobId: 'job-2' },
      'Failed to publish recovered document processing job'
    );

    await vi.advanceTimersByTimeAsync(intervalMilliseconds);
    expect(dependencies.log.warn).toHaveBeenCalledWith(
      { err: recoveryError },
      'Failed to recover and publish expired document processing leases'
    );
    await vi.advanceTimersByTimeAsync(intervalMilliseconds);
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledTimes(3);
    await publisher.close();
  });

  it('stops scheduling and waits for an active cycle during shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dependencies = createDependencies();
    const pendingCycle = deferred<typeof emptyResult>();
    dependencies.service.publishAvailableRetries
      .mockResolvedValueOnce(emptyResult)
      .mockReturnValueOnce(pendingCycle.promise);

    const publisher = await startDocumentProcessingRetryPublisher({
      ...dependencies,
      intervalMilliseconds
    });
    await vi.advanceTimersByTimeAsync(intervalMilliseconds);

    let closed = false;
    const closing = publisher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    pendingCycle.resolve(emptyResult);
    await closing;
    await vi.advanceTimersByTimeAsync(intervalMilliseconds * 2);
    expect(dependencies.service.publishAvailableRetries).toHaveBeenCalledTimes(2);
    expect(dependencies.service.publishRecoveredLeases).toHaveBeenCalledTimes(2);
  });
});
