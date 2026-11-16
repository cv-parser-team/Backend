import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../database/database.js';
import {
  createLlmRepository,
  type LlmInvocationRecord,
  type StartLlmInvocationInput
} from './llm.repository.js';

const startedAt = new Date('2026-01-01T00:00:00.000Z');
const startedInvocation: LlmInvocationRecord = {
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

function updateDatabase(returned: LlmInvocationRecord | undefined) {
  const returning = vi.fn().mockResolvedValue(
    returned === undefined ? [] : [returned]
  );
  const where = vi.fn<(condition: SQL) => { returning: typeof returning }>(
    () => ({ returning })
  );
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  return {
    database: { db: { update } } as unknown as AppDatabase,
    set,
    where
  };
}

describe('LLM repository', () => {
  it('starts an invocation with safe metadata only', async () => {
    const returning = vi.fn().mockResolvedValue([startedInvocation]);
    const values = vi.fn<
      (input: StartLlmInvocationInput) => { returning: typeof returning }
    >(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const database = { db: { insert } } as unknown as AppDatabase;
    const repository = createLlmRepository(database);

    await expect(
      repository.startInvocation({
        operationId: startedInvocation.operationId,
        task: startedInvocation.task,
        provider: startedInvocation.provider,
        model: startedInvocation.model,
        promptVersion: startedInvocation.promptVersion,
        contractVersion: startedInvocation.contractVersion
      })
    ).resolves.toEqual(startedInvocation);

    expect(values).toHaveBeenCalledWith({
      operationId: startedInvocation.operationId,
      task: 'candidate_extraction',
      provider: 'gemini',
      model: 'gemini-test',
      promptVersion: 'candidate-extraction-v1',
      contractVersion: 1
    });
    expect(Object.keys(values.mock.calls[0]![0])).not.toEqual(
      expect.arrayContaining(['prompt', 'input', 'apiKey', 'output'])
    );
  });

  it('completes only the targeted started invocation', async () => {
    const completedInvocation: LlmInvocationRecord = {
      ...startedInvocation,
      status: 'succeeded',
      providerRequestId: 'provider-request-1',
      inputTokens: 20,
      outputTokens: 8,
      completedAt: new Date('2026-01-01T00:00:01.000Z')
    };
    const { database, set, where } = updateDatabase(completedInvocation);
    const repository = createLlmRepository(database);

    await expect(
      repository.completeInvocation({
        invocationId: startedInvocation.invocationId,
        providerRequestId: 'provider-request-1',
        inputTokens: 20,
        outputTokens: 8
      })
    ).resolves.toEqual(completedInvocation);

    expect(set).toHaveBeenCalledWith({
      status: 'succeeded',
      providerRequestId: 'provider-request-1',
      inputTokens: 20,
      outputTokens: 8,
      errorCategory: null,
      errorCode: null,
      completedAt: expect.any(Date)
    });
    expectStartedInvocationCondition(where.mock.calls[0]?.[0]);
  });

  it('fails only the targeted started invocation with safe error metadata', async () => {
    const failedInvocation: LlmInvocationRecord = {
      ...startedInvocation,
      status: 'failed',
      errorCategory: 'timeout',
      errorCode: 'PROVIDER_TIMEOUT',
      completedAt: new Date('2026-01-01T00:00:01.000Z')
    };
    const { database, set, where } = updateDatabase(failedInvocation);
    const repository = createLlmRepository(database);

    await expect(
      repository.failInvocation({
        invocationId: startedInvocation.invocationId,
        errorCategory: 'timeout',
        errorCode: 'PROVIDER_TIMEOUT'
      })
    ).resolves.toEqual(failedInvocation);

    expect(set).toHaveBeenCalledWith({
      status: 'failed',
      errorCategory: 'timeout',
      errorCode: 'PROVIDER_TIMEOUT',
      completedAt: expect.any(Date)
    });
    expectStartedInvocationCondition(where.mock.calls[0]?.[0]);
  });

  it('returns null when an invocation has already finished', async () => {
    const { database } = updateDatabase(undefined);
    const repository = createLlmRepository(database);

    await expect(
      repository.completeInvocation({
        invocationId: startedInvocation.invocationId
      })
    ).resolves.toBeNull();
  });
});

function expectStartedInvocationCondition(condition: SQL | undefined): void {
  expect(condition).toBeDefined();
  const query = new PgDialect().sqlToQuery(condition!);
  expect(query.sql).toContain('"llm_invocations"."invocation_id" = $1');
  expect(query.sql).toContain('"llm_invocations"."status" = $2');
  expect(query.params).toEqual([
    startedInvocation.invocationId,
    'started'
  ]);
}
