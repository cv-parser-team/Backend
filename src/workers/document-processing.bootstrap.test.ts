import { describe, expect, it, vi } from 'vitest';
import type { ParseDocumentHandler } from '../modules/document-processing/index.js';
import { createFakeMessageBroker } from '../testing/fake-message-broker.js';
import {
  bootstrapDocumentProcessingWorker,
  type DocumentProcessingWorkerApp
} from './document-processing.bootstrap.js';

function createWorkerApp(): DocumentProcessingWorkerApp {
  const handler: Pick<ParseDocumentHandler, 'handle'> = {
    handle: vi.fn(async () => ({ outcome: 'skipped' as const }))
  };

  return {
    documentProcessingService: {
      publishAvailableRetries: vi.fn(async () => ({
        published: 0,
        failures: []
      })),
      publishRecoveredLeases: vi.fn(async () => ({
        published: 0,
        failures: []
      })),
      republishQueuedJobs: vi.fn(async () => ({
        published: 0,
        failures: []
      }))
    },
    log: {
      info: vi.fn(),
      warn: vi.fn()
    },
    messageBroker: createFakeMessageBroker(),
    parseDocumentHandler: handler,
    ready: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
}

describe('document processing worker bootstrap', () => {
  it('starts consumption after readiness and closes only once', async () => {
    const operations: string[] = [];
    const app = createWorkerApp();
    vi.mocked(app.ready).mockImplementation(async () => {
      operations.push('ready');
    });
    vi.mocked(
      app.documentProcessingService.republishQueuedJobs
    ).mockImplementation(async () => {
      operations.push('republish');
      return { published: 0, failures: [] };
    });
    vi.mocked(
      app.documentProcessingService.publishAvailableRetries
    ).mockImplementation(async () => {
      operations.push('publish-retries');
      return { published: 0, failures: [] };
    });
    vi.mocked(
      app.documentProcessingService.publishRecoveredLeases
    ).mockImplementation(async () => {
      operations.push('publish-recovered');
      return { published: 0, failures: [] };
    });
    vi.spyOn(app.messageBroker, 'consume').mockImplementation(async () => {
      operations.push('consume');
    });
    vi.mocked(app.close).mockImplementation(async () => {
      operations.push('close');
    });

    const worker = await bootstrapDocumentProcessingWorker(app);

    expect(operations).toEqual([
      'ready',
      'republish',
      'publish-retries',
      'publish-recovered',
      'consume'
    ]);
    await Promise.all([worker.close(), worker.close()]);
    expect(operations).toEqual([
      'ready',
      'republish',
      'publish-retries',
      'publish-recovered',
      'consume',
      'close'
    ]);
  });

  it('logs individual publication failures and still starts consumption', async () => {
    const publicationError = new Error('RabbitMQ unavailable');
    const app = createWorkerApp();
    const consume = vi.spyOn(app.messageBroker, 'consume');
    vi.mocked(
      app.documentProcessingService.republishQueuedJobs
    ).mockResolvedValue({
      published: 1,
      failures: [{ jobId: 'job-2', error: publicationError }]
    });

    const worker = await bootstrapDocumentProcessingWorker(app);

    expect(app.log.info).toHaveBeenCalledWith(
      { publishedJobs: 1 },
      'Republished queued document processing jobs'
    );
    expect(app.log.warn).toHaveBeenCalledWith(
      { err: publicationError, jobId: 'job-2' },
      'Failed to republish queued document processing job'
    );
    expect(consume).toHaveBeenCalledOnce();
    await worker.close();
  });

  it('closes initialized resources when consumption startup fails', async () => {
    const failure = new Error('consumer registration failed');
    const app = createWorkerApp();
    vi.spyOn(app.messageBroker, 'consume').mockRejectedValue(failure);

    await expect(bootstrapDocumentProcessingWorker(app)).rejects.toBe(failure);
    expect(app.close).toHaveBeenCalledOnce();
  });

  it('does not register a consumer when application readiness fails', async () => {
    const failure = new Error('application not ready');
    const app = createWorkerApp();
    const consume = vi.spyOn(app.messageBroker, 'consume');
    vi.mocked(app.ready).mockRejectedValue(failure);

    await expect(bootstrapDocumentProcessingWorker(app)).rejects.toBe(failure);
    expect(consume).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledOnce();
  });

  it('closes initialized resources when queued-job recovery fails', async () => {
    const failure = new Error('queued jobs unavailable');
    const app = createWorkerApp();
    const consume = vi.spyOn(app.messageBroker, 'consume');
    vi.mocked(
      app.documentProcessingService.republishQueuedJobs
    ).mockRejectedValue(failure);

    await expect(bootstrapDocumentProcessingWorker(app)).rejects.toBe(failure);
    expect(consume).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledOnce();
  });
});
