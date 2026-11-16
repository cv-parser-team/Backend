import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRequestRecord } from '../modules/normalization/normalization-ai-requests.repository.js';
import { startNormalizationAiWorker } from './normalization-ai.worker.js';

function aiRequest(requestId: string): AiRequestRecord {
  return { requestId, claimId: `claim-${requestId}` } as AiRequestRecord;
}

// Two requests are waiting; after them the queue is empty.
function setup(batchSize = 10) {
  const claimBatch = vi
    .fn()
    .mockResolvedValueOnce([aiRequest('r-1')])
    .mockResolvedValueOnce([aiRequest('r-2')])
    .mockResolvedValue([]);
  const process = vi.fn().mockResolvedValue('matched');
  const log = { info: vi.fn(), warn: vi.fn() };
  const worker = startNormalizationAiWorker({
    normalizationAi: { requests: { claimBatch }, processor: { process } },
    log,
    intervalMilliseconds: 1_000,
    batchSize
  });
  return { worker, claimBatch, process, log };
}

describe('normalization AI worker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claims each request only when its turn comes', async () => {
    const { worker, claimBatch, process, log } = setup();
    const order: string[] = [];
    claimBatch.mockReset();
    claimBatch.mockImplementation(async () => {
      order.push('claim');
      return [];
    });
    claimBatch
      .mockImplementationOnce(async () => {
        order.push('claim');
        return [aiRequest('r-1')];
      })
      .mockImplementationOnce(async () => {
        order.push('claim');
        return [aiRequest('r-2')];
      });
    process.mockImplementation(async (request: AiRequestRecord) => {
      order.push(`process ${request.requestId}`);
      return 'matched';
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(order).toEqual(['claim', 'process r-1', 'claim', 'process r-2', 'claim']);
    expect(claimBatch).toHaveBeenCalledWith(1, 120_000);
    expect(log.info).toHaveBeenCalledWith(
      { requestId: 'r-1', claimId: 'claim-r-1', outcome: 'matched' },
      'Processed normalization AI request'
    );
    await worker.close();
  });

  it('processes at most the batch size per cycle', async () => {
    const { worker, process } = setup(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(process).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(process).toHaveBeenCalledTimes(2);
    await worker.close();
  });

  it('keeps going when one request fails', async () => {
    const { worker, process, log } = setup();
    process.mockRejectedValueOnce(new Error('database unavailable'));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(process).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r-1' }),
      'Normalization AI request failed'
    );
    await worker.close();
  });

  it('tries again next interval when claiming fails', async () => {
    const { worker, claimBatch, process, log } = setup();
    claimBatch.mockReset();
    claimBatch
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce([aiRequest('r-1')])
      .mockResolvedValue([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to claim normalization AI requests'
    );
    expect(process).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(process).toHaveBeenCalledOnce();
    await worker.close();
  });

  it('waits for the active request on close and claims no more', async () => {
    const { worker, claimBatch, process } = setup();
    let finish: () => void = () => undefined;
    process.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve('matched')))
    );

    await vi.advanceTimersByTimeAsync(1_000);
    let closed = false;
    const closing = worker.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);

    finish();
    await closing;
    expect(process).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(claimBatch).toHaveBeenCalledOnce();
  });
});
