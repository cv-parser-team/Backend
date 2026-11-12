import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, LlmRequest } from './llm-client.js';
import { LlmError } from './llm.errors.js';
import type {
  LlmInvocationRecord,
  LlmRepository
} from './llm.repository.js';
import {
  createLlmService,
  type TrackedLlmRequest
} from './llm.service.js';

const startedAt = new Date('2026-01-01T00:00:00.000Z');
const invocation: LlmInvocationRecord = {
  invocationId: '11111111-1111-4111-8111-111111111111',
  operationId: '22222222-2222-4222-8222-222222222222',
  task: 'candidate_extraction',
  provider: 'gemini',
  model: 'gemini-test',
  promptVersion: 'candidate-extraction-v1',
  contractVersion: 1,
  status: 'started',
  providerRequestId: null,
  inputTokens: null,
  outputTokens: null,
  errorCategory: null,
  errorCode: null,
  startedAt,
  completedAt: null
};

const request: TrackedLlmRequest = {
  operationId: invocation.operationId,
  provider: invocation.provider,
  promptVersion: invocation.promptVersion,
  contractVersion: invocation.contractVersion,
  task: invocation.task,
  model: invocation.model,
  prompt: 'Extract candidate information.',
  input: 'Synthetic referenced CV text.',
  outputSchema: { type: 'object' },
  timeoutMs: 1_000
};

function dependencies() {
  const generate = vi.fn<(request: LlmRequest) => ReturnType<LlmClient['generate']>>();
  const startInvocation = vi.fn<LlmRepository['startInvocation']>();
  const completeInvocation = vi.fn<LlmRepository['completeInvocation']>();
  const failInvocation = vi.fn<LlmRepository['failInvocation']>();

  return {
    client: { generate } satisfies LlmClient,
    repository: {
      startInvocation,
      completeInvocation,
      failInvocation
    } satisfies LlmRepository,
    generate,
    startInvocation,
    completeInvocation,
    failInvocation
  };
}

describe('LLM service', () => {
  it('tracks one successful provider request without persisting its content', async () => {
    const deps = dependencies();
    deps.startInvocation.mockResolvedValue(invocation);
    deps.generate.mockResolvedValue({
      output: { claims: [] },
      providerRequestId: 'provider-request-1',
      inputTokens: 20,
      outputTokens: 8
    });
    deps.completeInvocation.mockResolvedValue({
      ...invocation,
      status: 'succeeded',
      providerRequestId: 'provider-request-1',
      inputTokens: 20,
      outputTokens: 8,
      completedAt: new Date('2026-01-01T00:00:01.000Z')
    });
    const service = createLlmService(deps.client, deps.repository);

    await expect(service.generate(request)).resolves.toEqual({
      invocationId: invocation.invocationId,
      output: { claims: [] },
      providerRequestId: 'provider-request-1',
      inputTokens: 20,
      outputTokens: 8
    });

    expect(deps.startInvocation).toHaveBeenCalledWith({
      operationId: invocation.operationId,
      task: 'candidate_extraction',
      provider: 'gemini',
      model: 'gemini-test',
      promptVersion: 'candidate-extraction-v1',
      contractVersion: 1
    });
    expect(deps.startInvocation).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: request.prompt, input: request.input })
    );
    expect(deps.generate).toHaveBeenCalledOnce();
    expect(deps.completeInvocation).toHaveBeenCalledWith({
      invocationId: invocation.invocationId,
      providerRequestId: 'provider-request-1',
      inputTokens: 20,
      outputTokens: 8
    });
    expect(deps.failInvocation).not.toHaveBeenCalled();
  });

  it('records safe provider failure metadata and rethrows the same error', async () => {
    const deps = dependencies();
    const providerError = new LlmError(
      'The LLM provider request timed out',
      'timeout',
      'PROVIDER_TIMEOUT'
    );
    deps.startInvocation.mockResolvedValue(invocation);
    deps.generate.mockRejectedValue(providerError);
    deps.failInvocation.mockResolvedValue({
      ...invocation,
      status: 'failed',
      errorCategory: 'timeout',
      errorCode: 'PROVIDER_TIMEOUT',
      completedAt: new Date('2026-01-01T00:00:01.000Z')
    });
    const service = createLlmService(deps.client, deps.repository);

    await expect(service.generate(request)).rejects.toBe(providerError);
    expect(deps.failInvocation).toHaveBeenCalledWith({
      invocationId: invocation.invocationId,
      errorCategory: 'timeout',
      errorCode: 'PROVIDER_TIMEOUT'
    });
    expect(deps.completeInvocation).not.toHaveBeenCalled();
  });

  it('does not call the provider when starting the invocation fails', async () => {
    const deps = dependencies();
    const databaseError = new Error('database unavailable');
    deps.startInvocation.mockRejectedValue(databaseError);
    const service = createLlmService(deps.client, deps.repository);

    await expect(service.generate(request)).rejects.toBe(databaseError);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.completeInvocation).not.toHaveBeenCalled();
    expect(deps.failInvocation).not.toHaveBeenCalled();
  });

  it('maps an unexpected client failure to safe metadata', async () => {
    const deps = dependencies();
    deps.startInvocation.mockResolvedValue(invocation);
    deps.generate.mockRejectedValue(
      new Error('raw provider detail that must not escape')
    );
    deps.failInvocation.mockResolvedValue({
      ...invocation,
      status: 'failed',
      errorCategory: 'provider_unavailable',
      errorCode: 'UNEXPECTED_PROVIDER_ERROR',
      completedAt: new Date('2026-01-01T00:00:01.000Z')
    });
    const service = createLlmService(deps.client, deps.repository);

    const error = await service.generate(request).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      message: 'The LLM provider failed unexpectedly',
      category: 'provider_unavailable',
      code: 'UNEXPECTED_PROVIDER_ERROR'
    });
    expect(error).not.toHaveProperty('cause');
    expect(deps.failInvocation).toHaveBeenCalledWith({
      invocationId: invocation.invocationId,
      errorCategory: 'provider_unavailable',
      errorCode: 'UNEXPECTED_PROVIDER_ERROR'
    });
  });
});
