import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { llmInvocations, llmInvocationStatus } from './llm.table.js';

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

describe('LLM invocations table', () => {
  const dialect = new PgDialect();
  const tableConfig = getTableConfig(llmInvocations);
  const constraints = new Map(
    tableConfig.checks.map((constraint) => [
      constraint.name,
      normalizeSql(dialect.sqlToQuery(constraint.value).sql)
    ])
  );

  it('defines the complete invocation lifecycle', () => {
    expect(llmInvocationStatus.enumValues).toEqual([
      'started',
      'succeeded',
      'failed'
    ]);
    expect(llmInvocations.status.default).toBe('started');
    expect(llmInvocations.startedAt.hasDefault).toBe(true);
    expect(llmInvocations.completedAt.notNull).toBe(false);
  });

  it('has no feature or job foreign keys', () => {
    expect(tableConfig.foreignKeys).toEqual([]);
  });

  it('indexes operations and task chronology', () => {
    const indexes = new Map(
      tableConfig.indexes.map((tableIndex) => [
        tableIndex.config.name,
        tableIndex.config.columns.map((column) =>
          'name' in column ? column.name : undefined
        )
      ])
    );

    expect(indexes.get('llm_invocations_operation_id_idx')).toEqual([
      'operation_id'
    ]);
    expect(indexes.get('llm_invocations_task_started_at_idx')).toEqual([
      'task',
      'started_at'
    ]);
  });

  it('uniquely tracks provider request IDs only when present', () => {
    const providerRequestIndex = tableConfig.indexes.find(
      (tableIndex) =>
        tableIndex.config.name ===
        'llm_invocations_provider_request_id_unique'
    );

    expect(providerRequestIndex?.config.unique).toBe(true);
    expect(
      providerRequestIndex?.config.columns.map((column) =>
        'name' in column ? column.name : undefined
      )
    ).toEqual(['provider', 'provider_request_id']);
    expect(
      providerRequestIndex?.config.where
        ? normalizeSql(
            dialect.sqlToQuery(providerRequestIndex.config.where).sql
          )
        : undefined
    ).toBe('"llm_invocations"."provider_request_id" is not null');
  });

  it('enforces versions, token counts, and completion order', () => {
    expect(constraints.get('llm_invocations_contract_version_positive')).toBe(
      '"llm_invocations"."contract_version" > 0'
    );
    expect(constraints.get('llm_invocations_input_tokens_nonnegative')).toBe(
      '"llm_invocations"."input_tokens" is null or "llm_invocations"."input_tokens" >= 0'
    );
    expect(constraints.get('llm_invocations_output_tokens_nonnegative')).toBe(
      '"llm_invocations"."output_tokens" is null or "llm_invocations"."output_tokens" >= 0'
    );
    expect(constraints.get('llm_invocations_completion_order')).toBe(
      '"llm_invocations"."completed_at" is null or "llm_invocations"."completed_at" >= "llm_invocations"."started_at"'
    );
  });
});
