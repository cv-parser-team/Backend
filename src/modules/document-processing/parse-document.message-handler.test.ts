import { describe, expect, it, vi } from 'vitest';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type {
  ParseDocumentHandler,
  ParseDocumentHandlerResult
} from './parse-document.handler.js';
import {
  createParseDocumentMessageHandler,
  type ParseDocumentMessageLogger
} from './parse-document.message-handler.js';
import type { ParseDocumentJob } from './parse-document.job.js';

const job: ParseDocumentJob = {
  version: 1,
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222'
};
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const completedJob: ProcessingJobRecord = {
  jobId: job.jobId,
  documentId: job.documentId,
  status: 'completed',
  attemptCount: 1,
  failureCode: null,
  availableAt: timestamp,
  lockedUntil: null,
  createdAt: timestamp,
  updatedAt: timestamp
};
const failedJob: ProcessingJobRecord = {
  ...completedJob,
  status: 'failed',
  failureCode: 'PARSING_FAILED'
};
const retryingJob: ProcessingJobRecord = {
  ...completedJob,
  status: 'retrying',
  failureCode: 'PARSING_FAILED'
};

function createHandler(
  result: ParseDocumentHandlerResult
): Pick<ParseDocumentHandler, 'handle'> {
  return {
    handle: vi.fn().mockResolvedValue(result)
  };
}

function createLogger(): ParseDocumentMessageLogger {
  return {
    info: vi.fn(),
    warn: vi.fn()
  };
}

describe('parse document message handler', () => {
  it.each([
    { outcome: 'processed', processingJob: completedJob },
    { outcome: 'retrying', processingJob: retryingJob },
    { outcome: 'cancelled', processingJob: failedJob },
    { outcome: 'skipped' }
  ] satisfies ParseDocumentHandlerResult[])(
    'acknowledges $outcome jobs',
    async (result) => {
      const handler = createHandler(result);
      const log = createLogger();
      const messageHandler = createParseDocumentMessageHandler({
        handler,
        log
      });

      await expect(messageHandler(job)).resolves.toBe('ack');
      expect(handler.handle).toHaveBeenCalledWith(job);
      expect(log.info).toHaveBeenNthCalledWith(
        1,
        { jobId: job.jobId, documentId: job.documentId },
        'Received document processing job'
      );
      expect(log.info).toHaveBeenNthCalledWith(
        2,
        {
          jobId: job.jobId,
          documentId: job.documentId,
          outcome: result.outcome,
          ...(result.outcome === 'retrying' || result.outcome === 'cancelled'
            ? {
                attemptCount: result.processingJob.attemptCount,
                failureCode: result.processingJob.failureCode
              }
            : {})
        },
        'Handled document processing job'
      );
    }
  );

  it('acknowledges a stale attempt and warns about it', async () => {
    const handler = createHandler({ outcome: 'stale' });
    const log = createLogger();
    const messageHandler = createParseDocumentMessageHandler({ handler, log });

    await expect(messageHandler(job)).resolves.toBe('ack');
    expect(log.warn).toHaveBeenCalledWith(
      { jobId: job.jobId, documentId: job.documentId },
      'Document processing attempt stopped because another attempt claimed the job'
    );
  });

  it('rejects permanently failed jobs without requeueing', async () => {
    const handler = createHandler({
      outcome: 'failed',
      processingJob: failedJob
    });
    const log = createLogger();
    const messageHandler = createParseDocumentMessageHandler({ handler, log });

    await expect(messageHandler(job)).resolves.toBe('reject');
    expect(handler.handle).toHaveBeenCalledWith(job);
    expect(log.info).toHaveBeenLastCalledWith(
      {
        jobId: job.jobId,
        documentId: job.documentId,
        outcome: 'failed',
        attemptCount: failedJob.attemptCount,
        failureCode: failedJob.failureCode
      },
      'Handled document processing job'
    );
  });

  it.each([
    null,
    { ...job, version: 2 },
    { ...job, jobId: 'not-a-uuid' },
    { ...job, documentId: undefined }
  ])(
    'rejects invalid payloads without invoking the handler',
    async (message) => {
      const handler = createHandler({ outcome: 'skipped' });
      const log = createLogger();
      const messageHandler = createParseDocumentMessageHandler({
        handler,
        log
      });

      await expect(messageHandler(message)).resolves.toBe('reject');
      expect(handler.handle).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Rejected invalid document processing message'
      );
      const [context] = vi.mocked(log.warn).mock.calls[0] ?? [];
      expect(context).not.toHaveProperty('message');
      expect(context).not.toHaveProperty('jobId');
      expect(context).not.toHaveProperty('documentId');
    }
  );

  it('propagates handler failures for broker retry', async () => {
    const failure = new Error('database temporarily unavailable');
    const handler: Pick<ParseDocumentHandler, 'handle'> = {
      handle: vi.fn().mockRejectedValue(failure)
    };
    const log = createLogger();
    const messageHandler = createParseDocumentMessageHandler({ handler, log });

    await expect(messageHandler(job)).rejects.toBe(failure);
    expect(log.warn).toHaveBeenCalledWith(
      { jobId: job.jobId, documentId: job.documentId, err: failure },
      'Document processing job handler failed'
    );
  });
});
