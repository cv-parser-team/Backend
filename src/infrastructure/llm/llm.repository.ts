import { and, eq } from 'drizzle-orm';
import { withDbErrors } from '../database/database.errors.js';
import type { AppDatabase } from '../database/database.js';
import type { LlmErrorCategory } from './llm.errors.js';
import { llmInvocations } from './llm.table.js';

export type LlmInvocationRecord = typeof llmInvocations.$inferSelect;

export interface StartLlmInvocationInput {
  operationId: string;
  task: string;
  provider: string;
  model: string;
  promptVersion: string;
  contractVersion: number;
}

export interface CompleteLlmInvocationInput {
  invocationId: string;
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FailLlmInvocationInput {
  invocationId: string;
  errorCategory: LlmErrorCategory;
  errorCode?: string;
}

export interface LlmRepository {
  startInvocation(
    input: StartLlmInvocationInput
  ): Promise<LlmInvocationRecord>;
  completeInvocation(
    input: CompleteLlmInvocationInput
  ): Promise<LlmInvocationRecord | null>;
  failInvocation(
    input: FailLlmInvocationInput
  ): Promise<LlmInvocationRecord | null>;
}

export function createLlmRepository(database: AppDatabase): LlmRepository {
  return {
    async startInvocation(input) {
      return withDbErrors('LLM invocation', async () => {
        const [invocation] = await database.db
          .insert(llmInvocations)
          .values(input)
          .returning();

        if (!invocation) {
          throw new Error('LLM invocation creation returned no record');
        }

        return invocation;
      });
    },

    async completeInvocation({
      invocationId,
      providerRequestId,
      inputTokens,
      outputTokens
    }) {
      return withDbErrors('LLM invocation', async () => {
        const [invocation] = await database.db
          .update(llmInvocations)
          .set({
            status: 'succeeded',
            providerRequestId: providerRequestId ?? null,
            inputTokens: inputTokens ?? null,
            outputTokens: outputTokens ?? null,
            errorCategory: null,
            errorCode: null,
            completedAt: new Date()
          })
          .where(
            and(
              eq(llmInvocations.invocationId, invocationId),
              eq(llmInvocations.status, 'started')
            )
          )
          .returning();

        return invocation ?? null;
      });
    },

    async failInvocation({ invocationId, errorCategory, errorCode }) {
      return withDbErrors('LLM invocation', async () => {
        const [invocation] = await database.db
          .update(llmInvocations)
          .set({
            status: 'failed',
            errorCategory,
            errorCode: errorCode ?? null,
            completedAt: new Date()
          })
          .where(
            and(
              eq(llmInvocations.invocationId, invocationId),
              eq(llmInvocations.status, 'started')
            )
          )
          .returning();

        return invocation ?? null;
      });
    }
  };
}
