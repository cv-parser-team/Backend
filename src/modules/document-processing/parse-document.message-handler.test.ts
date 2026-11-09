import { describe, expect, it, vi } from 'vitest';
import type { ProcessingJobRecord } from './document-processing.repository.js';
import type {
  ParseDocumentHandler,
  ParseDocumentHandlerResult
} from './parse-document.handler.js';
import { createParseDocumentMessageHandler } from './parse-document.message-handler.js';
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

function createHandler(
  result: ParseDocumentHandlerResult
): Pick<ParseDocumentHandler, 'handle'> {
  return {
    handle: vi.fn().mockResolvedValue(result)
  };
}

describe('parse document message handler', () => {
  it.each([
    { outcome: 'processed', processingJob: completedJob },
    { outcome: 'skipped' }
  ] satisfies ParseDocumentHandlerResult[])(
    'acknowledges $outcome jobs',
    async (result) => {
      const handler = createHandler(result);
      const messageHandler = createParseDocumentMessageHandler({ handler });

      await expect(messageHandler(job)).resolves.toBe('ack');
      expect(handler.handle).toHaveBeenCalledWith(job);
    }
  );

  it.each([
    null,
    { ...job, version: 2 },
    { ...job, jobId: 'not-a-uuid' },
    { ...job, documentId: undefined }
  ])(
    'rejects invalid payloads without invoking the handler',
    async (message) => {
      const handler = createHandler({ outcome: 'skipped' });
      const messageHandler = createParseDocumentMessageHandler({ handler });

      await expect(messageHandler(message)).resolves.toBe('reject');
      expect(handler.handle).not.toHaveBeenCalled();
    }
  );

  it('propagates handler failures for broker retry', async () => {
    const failure = new Error('database temporarily unavailable');
    const handler: Pick<ParseDocumentHandler, 'handle'> = {
      handle: vi.fn().mockRejectedValue(failure)
    };
    const messageHandler = createParseDocumentMessageHandler({ handler });

    await expect(messageHandler(job)).rejects.toBe(failure);
  });
});
