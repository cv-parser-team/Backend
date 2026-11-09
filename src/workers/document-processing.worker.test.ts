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

describe('document processing worker', () => {
  it('registers the parse handler and exposes its delivery dispositions', async () => {
    const broker = createFakeMessageBroker();
    const handler: Pick<ParseDocumentHandler, 'handle'> = {
      handle: vi.fn(async () => ({ outcome: 'skipped' as const }))
    };

    await startDocumentProcessingWorker({ broker, handler });

    expect(broker.consumers.has(PARSE_DOCUMENT_QUEUE)).toBe(true);
    await expect(broker.deliver(PARSE_DOCUMENT_QUEUE, job)).resolves.toBe(
      'ack'
    );
    expect(handler.handle).toHaveBeenCalledWith(job);

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

    await startDocumentProcessingWorker({ broker, handler });

    await expect(broker.deliver(PARSE_DOCUMENT_QUEUE, job)).rejects.toBe(
      failure
    );
  });
});
