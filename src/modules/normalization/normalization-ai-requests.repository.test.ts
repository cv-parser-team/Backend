import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import * as schema from '../../infrastructure/database/schema.js';
import { createAiRequestRepository } from './normalization-ai-requests.repository.js';
import { normalizationAiRequests } from './normalization.table.js';

interface CapturedQuery {
  text: string;
  values: unknown[];
}

// Runs the repository's real queries against a connection that records the
// SQL instead of sending it, and answers every query with `rows`.
function recordingDatabase(rows: Record<string, unknown>[] = []) {
  const queries: CapturedQuery[] = [];
  const client = {
    query: async (
      query: { text: string; values?: unknown[] } | string,
      params?: unknown[]
    ) => {
      const text = typeof query === 'string' ? query : query.text;
      const values = params ?? (typeof query === 'string' ? [] : (query.values ?? []));
      queries.push({ text, values });
      return { rows, rowCount: rows.length, fields: [], command: 'SELECT' };
    },
    connect: async () => ({ ...client, release: () => undefined })
  };
  const db = drizzle({ client: client as never, schema });
  return { database: { db } as unknown as AppDatabase, queries };
}

const claim = { requestId: '11111111-1111-4111-8111-111111111111', attemptCount: 2 };

describe('normalization AI requests table', () => {
  const config = getTableConfig(normalizationAiRequests);

  it('keeps one active request per claim', () => {
    const index = config.indexes.find(
      (candidate) => candidate.config.name === 'normalization_ai_requests_active_claim_unique'
    );
    expect(index?.config.unique).toBe(true);
    expect(
      index?.config.where ? new PgDialect().sqlToQuery(index.config.where).sql : undefined
    ).toBe(`"normalization_ai_requests"."status" in ('queued', 'processing')`);
  });

  it('deletes requests with their claim', () => {
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('starts requests queued, available now, with no attempts', () => {
    expect(normalizationAiRequests.status.default).toBe('queued');
    expect(normalizationAiRequests.attemptCount.default).toBe(0);
    expect(normalizationAiRequests.availableAt.hasDefault).toBe(true);
  });
});

describe('normalization AI request repository', () => {
  it('supersedes the active request of the claim before queueing a new one', async () => {
    const { database, queries } = recordingDatabase([{ requestId: claim.requestId }]);

    await createAiRequestRepository(database).enqueue({
      claimId: '22222222-2222-4222-8222-222222222222',
      category: 'skill',
      originalValue: 'Pyhton',
      context: {},
      preferredTermIds: []
    });

    const statements = queries.map((query) => query.text.toLowerCase());
    expect(statements[0]).toBe('begin');
    expect(statements[1]).toContain('update "normalization_ai_requests" set "status" = $1');
    expect(statements[1]).toContain(`"status" in ('queued', 'processing')`);
    expect(queries[1]?.values).toContain('superseded');
    expect(statements[2]).toContain('insert into "normalization_ai_requests"');
    expect(statements[3]).toBe('commit');
  });

  it('claims due or abandoned requests that no other worker holds', async () => {
    const { database, queries } = recordingDatabase();

    await createAiRequestRepository(database).claimBatch(10, 60_000);

    const text = queries[0]?.text.toLowerCase() ?? '';
    expect(text).toContain('for update skip locked');
    expect(text).toContain('"attempt_count" = "normalization_ai_requests"."attempt_count" + 1');
    expect(text).toContain(`"status" = $`);
    expect(text).toContain('"available_at" <= now()');
    expect(text).toContain('"locked_until" <= now()');
    expect(queries[0]?.values).toEqual(
      expect.arrayContaining(['processing', 'queued', 60_000, 10])
    );
  });

  it.each([
    ['complete', (repository: ReturnType<typeof createAiRequestRepository>) => repository.complete(claim)],
    ['supersede', (repository: ReturnType<typeof createAiRequestRepository>) => repository.supersede(claim)],
    ['retry', (repository: ReturnType<typeof createAiRequestRepository>) => repository.retry(claim, 'rate_limited', 30_000)],
    ['fail', (repository: ReturnType<typeof createAiRequestRepository>) => repository.fail(claim, 'invalid_output')]
  ])('%s only changes the request this claim still owns', async (_name, finish) => {
    const { database, queries } = recordingDatabase();

    await expect(finish(createAiRequestRepository(database))).resolves.toBe(false);

    const text = queries[0]?.text ?? '';
    expect(text).toContain('"normalization_ai_requests"."request_id" = $');
    expect(text).toContain('"normalization_ai_requests"."attempt_count" = $');
    expect(queries[0]?.values).toEqual(
      expect.arrayContaining([claim.requestId, 'processing', claim.attemptCount])
    );
  });

  it('locks the claimed request for update', async () => {
    const { database, queries } = recordingDatabase();
    const repository = createAiRequestRepository(database);

    await repository.lockClaimed(claim, database.db);

    expect(queries[0]?.text.toLowerCase()).toContain('for update');
  });
});
