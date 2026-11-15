import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { LlmErrorCategory } from './llm.errors.js';

export const llmInvocationStatus = pgEnum('llm_invocation_status', [
  'started',
  'succeeded',
  'failed'
]);

export type LlmInvocationStatus =
  (typeof llmInvocationStatus.enumValues)[number];

export const llmInvocations = pgTable(
  'llm_invocations',
  {
    invocationId: uuid('invocation_id').primaryKey().defaultRandom(),
    operationId: uuid('operation_id').notNull(),
    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    contractVersion: integer('contract_version').notNull(),
    status: llmInvocationStatus('status').default('started').notNull(),
    providerRequestId: text('provider_request_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    errorCategory: text('error_category').$type<LlmErrorCategory>(),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date'
    })
  },
  (table) => [
    index('llm_invocations_operation_id_idx').on(table.operationId),
    index('llm_invocations_task_started_at_idx').on(
      table.task,
      table.startedAt
    ),
    uniqueIndex('llm_invocations_provider_request_id_unique')
      .on(table.provider, table.providerRequestId)
      .where(sql`${table.providerRequestId} is not null`),
    check(
      'llm_invocations_contract_version_positive',
      sql`${table.contractVersion} > 0`
    ),
    check(
      'llm_invocations_input_tokens_nonnegative',
      sql`${table.inputTokens} is null or ${table.inputTokens} >= 0`
    ),
    check(
      'llm_invocations_output_tokens_nonnegative',
      sql`${table.outputTokens} is null or ${table.outputTokens} >= 0`
    ),
    check(
      'llm_invocations_completion_order',
      sql`${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt}`
    )
  ]
);
