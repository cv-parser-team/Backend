import type { FastifyBaseLogger } from 'fastify';
import type { NormalizationAi } from '../modules/normalization/index.js';

// A request whose worker stops longer than this is claimed again. It covers an
// LLM call with its timeout and the transaction that follows.
const AI_REQUEST_LEASE_MILLISECONDS = 2 * 60 * 1000;

export interface NormalizationAiWorkerDependencies {
  normalizationAi: Pick<NormalizationAi, 'requests' | 'processor'>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  intervalMilliseconds: number;
  batchSize: number;
}

export interface RunningNormalizationAiWorker {
  close(): Promise<void>;
}

// Polls for AI normalization requests and processes them one at a time. A
// cycle starts only after the previous one finished, so cycles never overlap.
export function startNormalizationAiWorker({
  normalizationAi,
  log,
  intervalMilliseconds,
  batchSize
}: NormalizationAiWorkerDependencies): RunningNormalizationAiWorker {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeCycle: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const runCycle = async (): Promise<void> => {
    let requests;
    try {
      requests = await normalizationAi.requests.claimBatch(
        batchSize,
        AI_REQUEST_LEASE_MILLISECONDS
      );
    } catch (error) {
      log.warn({ err: error }, 'Failed to claim normalization AI requests');
      return;
    }

    for (const request of requests) {
      if (stopped) {
        // Unprocessed requests are claimed again once their lease expires.
        return;
      }
      const context = { requestId: request.requestId, claimId: request.claimId };
      try {
        const outcome = await normalizationAi.processor.process(request);
        log.info({ ...context, outcome }, 'Processed normalization AI request');
      } catch (error) {
        log.warn({ ...context, err: error }, 'Normalization AI request failed');
      }
    }
  };

  const scheduleNextCycle = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      activeCycle = runCycle().finally(() => {
        activeCycle = undefined;
        scheduleNextCycle();
      });
    }, intervalMilliseconds);
  };

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
