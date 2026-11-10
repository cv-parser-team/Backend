import { describe, expect, it, vi } from 'vitest';
import type { ParseDocumentHandler } from '../modules/document-processing/index.js';
import {
  PARSE_DOCUMENT_QUEUE,
  PARSE_DOCUMENT_JOB_VERSION
} from '../modules/document-processing/index.js';
import { createFakeMessageBroker } from '../testing/fake-message-broker.js';
import { startDocumentProcessingWorker } from './document-processing.worker.js';

const job = {
  version: PARSE_DOCUMENT_JOB_VERSION,
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222'
};
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const failedJob = {
  jobId: job.jobId,
  documentId: job.documentId,
  status: 'failed' as const,
  attemptCount: 1,
  failureCode: 'PARSING_FAILED',
  availableAt: timestamp,
  lockedUntil: null,
  createdAt: timestamp,
  updatedAt: timestamp
};

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn()
  };
}

describe('document processing worker', () => {
  it('registers the parse handler and exposes its delivery dispositions', async () => {
    const broker = createFakeMessageBroker();
    const handler: Pick<ParseDocumentHandler, 'handle'> = {
      handle: vi.fn(async () => ({ outcome: 'skipped' as const }))
    };
    const log = createLogger();

    await startDocumentProcessingWorker({ broker, handler, log });

    expect(broker.consumers.has(PARSE_DOCUMENT_QUEUE)).toBe(true);
    expect(broker.consumerOptions.get(PARSE_DOCUMENT_QUEUE)).toEqual({
      maxInFlight: 1
    });
    await expect(broker.deliver(PARSE_DOCUMENT_QUEUE, job)).resolves.toBe(
      'ack'
    );
    expect(handler.handle).toHaveBeenCalledWith(job);
    expect(log.info).toHaveBeenLastCalledWith(
      { jobId: job.jobId, documentId: job.documentId, outcome: 'skipped' },
      'Handled document processing job'
    );

    await expect(
      broker.deliver(PARSE_DOCUMENT_QUEUE, { ...job, version: 2 })
    ).resolves.toBe('reject');
    expect(handler.handle).toHaveBeenCalledOnce();
  });

  it('propagates handler failures to the broker', async () => {
    const failure = new Error('processing unavailable');
    const broker = createFakeMessageBroker();
    const handler: Pick<ParseDocumentHandler, 'handle'> = {
      handle: vi.fn().mockRejectedValue(failure)
    };
    const log = createLogger();

    await startDocumentProcessingWorker({ broker, handler, log });

    await expect(broker.deliver(PARSE_DOCUMENT_QUEUE, job)).rejects.toBe(
      failure
    );
    expect(log.warn).toHaveBeenCalledWith(
      { jobId: job.jobId, documentId: job.documentId, err: failure },
      'Document processing job handler failed'
    );
  });

  it('rejects jobs that reached a permanent failed state', async () => {
    const broker = createFakeMessageBroker();
    const handler: Pick<ParseDocumentHandler, 'handle'> = {
      handle: vi.fn().mockResolvedValue({
        outcome: 'failed',
        processingJob: failedJob
      })
    };
    const log = createLogger();

    await startDocumentProcessingWorker({ broker, handler, log });

    await expect(broker.deliver(PARSE_DOCUMENT_QUEUE, job)).resolves.toBe(
      'reject'
    );
  });
});
