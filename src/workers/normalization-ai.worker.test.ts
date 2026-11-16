import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRequestRecord } from '../modules/normalization/normalization-ai-requests.repository.js';
import { startNormalizationAiWorker } from './normalization-ai.worker.js';

function aiRequest(requestId: string): AiRequestRecord {
  return { requestId, claimId: `claim-${requestId}` } as AiRequestRecord;
}

function setup() {
  const claimBatch = vi.fn().mockResolvedValue([aiRequest('r-1'), aiRequest('r-2')]);
  const process = vi.fn().mockResolvedValue('matched');
  const log = { info: vi.fn(), warn: vi.fn() };
  const worker = startNormalizationAiWorker({
    normalizationAi: { requests: { claimBatch }, processor: { process } },
    log,
    intervalMilliseconds: 1_000,
    batchSize: 10
  });
  return { worker, claimBatch, process, log };
}

describe('normalization AI worker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claims a batch every interval and processes each request', async () => {
    const { worker, claimBatch, process, log } = setup();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(claimBatch).toHaveBeenCalledWith(10, 120_000);
    expect(process).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      { requestId: 'r-1', claimId: 'claim-r-1', outcome: 'matched' },
      'Processed normalization AI request'
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(claimBatch).toHaveBeenCalledTimes(2);
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
    const { worker, claimBatch, log } = setup();
    claimBatch.mockRejectedValueOnce(new Error('database unavailable'));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to claim normalization AI requests'
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(claimBatch).toHaveBeenCalledTimes(2);
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
