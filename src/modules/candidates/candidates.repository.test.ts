import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  type CandidateRecord,
  type ClaimRecord,
  createCandidatesRepository
} from './candidates.repository.js';
import {
  claimRevisions,
  claims,
  employmentDetails,
  sourceOccurrences,
  skillDetails
} from './candidates.table.js';

const candidateId = '11111111-1111-4111-8111-111111111111';
const claimId = '22222222-2222-4222-8222-222222222222';
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const deadlock = { code: '40P01', message: 'deadlock detected' };
const uniqueViolation = { code: '23505', message: 'duplicate key' };
const dialect = new PgDialect();

function toSql(condition: SQL | undefined) {
  return condition ? dialect.sqlToQuery(condition) : undefined;
}

const claim: ClaimRecord = {
  claimId,
  claimType: 'skill',
  origin: 'manual',
  status: 'accepted',
  values: { name: 'TypeScript' },
  extraction: null,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp
};

// A row as the claim query reads it: the claim joined with its details.
function claimRow(version: number, name = 'TypeScript') {
  return {
    claim: {
      claimId,
      candidateId,
      claimType: 'skill',
      origin: 'manual',
      status: 'accepted',
      extractionInvocationId: null,
      extractionDocumentId: null,
      extractionRawValues: null,
      extractionFieldSources: null,
      extractionCurrent: null,
      version,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    skill: { claimId, name },
    employment: null,
    education: null,
    certification: null,
    language: null,
    project: null
  };
}

// A transaction that runs the repository's real queries against canned rows:
// `locked` answers the row lock, and `reads` answers each claim read in turn.
function createClaimTransaction(locked: unknown[], reads: unknown[][]) {
  const lock = vi.fn(() => Promise.resolve(locked));
  const lockWhere = vi.fn<(condition: SQL) => unknown>(() => ({ for: lock }));
  const read = vi.fn(() => Promise.resolve(reads.shift() ?? []));
  const readQuery = {
    leftJoin: () => readQuery,
    where: () => ({ orderBy: read })
  };
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: () => ('claim' in fields ? readQuery : { where: lockWhere })
  }));

  const inserted = vi.fn((_values: unknown) => Promise.resolve());
  const insert = vi.fn((table: unknown) => ({
    values: (values: unknown) => {
      expect(table).toBe(claimRevisions);
      return inserted(values);
    }
  }));

  const claimUpdates: Record<string, unknown>[] = [];
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      if (table === claims) {
        claimUpdates.push(values);
      }
      return { where: () => Promise.resolve() };
    }
  }));

  return {
    transaction: { select, insert, update },
    lock,
    lockWhere,
    inserted,
    update,
    claimUpdates
  };
}

function databaseWith(transaction: unknown): AppDatabase {
  return {
    db: { transaction: (work: (tx: unknown) => Promise<unknown>) => work(transaction) }
  } as unknown as AppDatabase;
}

describe('editing a claim', () => {
  const edit = (expectedVersion?: number) => ({
    candidateId,
    claimId,
    values: { name: 'Node.js' },
    expectedVersion
  });

  it('locks the claim row before reading it', async () => {
    const tx = createClaimTransaction([{ claimId }], [[claimRow(1)], [claimRow(2, 'Node.js')]]);
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    await repository.updateClaimValues(edit(1));

    expect(tx.lock).toHaveBeenCalledWith('update');
    const query = toSql(tx.lockWhere.mock.calls[0]?.[0]);
    expect(query?.params).toEqual([claimId, candidateId]);
  });

  it('archives the old values and increases the version when versions match', async () => {
    const tx = createClaimTransaction([{ claimId }], [[claimRow(1)], [claimRow(2, 'Node.js')]]);
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    const result = await repository.updateClaimValues(edit(1));

    expect(result).toMatchObject({
      status: 'saved',
      record: { version: 2, values: { name: 'Node.js' } }
    });
    expect(tx.inserted).toHaveBeenCalledWith({
      claimId,
      previousValues: { name: 'TypeScript' }
    });
    const versionUpdate = tx.claimUpdates[0]?.version as SQL | undefined;
    expect(toSql(versionUpdate)?.sql).toBe('"claims"."version" + 1');
  });

  it('refuses an edit based on an older version and writes nothing', async () => {
    const tx = createClaimTransaction([{ claimId }], [[claimRow(2)]]);
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    const result = await repository.updateClaimValues(edit(1));

    expect(result).toEqual({
      status: 'conflict',
      current: expect.objectContaining({ version: 2, values: { name: 'TypeScript' } })
    });
    expect(tx.inserted).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('saves without a version check when no version is given', async () => {
    const tx = createClaimTransaction([{ claimId }], [[claimRow(5)], [claimRow(6, 'Node.js')]]);
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    await expect(repository.updateClaimValues(edit())).resolves.toMatchObject({
      status: 'saved'
    });
  });

  it('reports a missing claim without reading or writing', async () => {
    const tx = createClaimTransaction([], []);
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    await expect(repository.updateClaimValues(edit(1))).resolves.toEqual({
      status: 'missing'
    });
    expect(tx.inserted).not.toHaveBeenCalled();
  });
});

describe('deleting a claim', () => {
  function createDeleteDatabase(deleted: unknown[], current: unknown[]) {
    const where = vi.fn<(condition: SQL) => unknown>(() => ({
      returning: () => Promise.resolve(deleted)
    }));
    const readQuery = {
      leftJoin: () => readQuery,
      where: () => ({ orderBy: () => Promise.resolve(current) })
    };
    const database = {
      db: {
        delete: () => ({ where }),
        select: () => ({ from: () => readQuery })
      }
    } as unknown as AppDatabase;
    return { database, where };
  }

  it('deletes only the expected version', async () => {
    const { database, where } = createDeleteDatabase([{ claimId }], []);

    await expect(
      createCandidatesRepository(database).deleteClaim(candidateId, claimId, 3)
    ).resolves.toEqual({ status: 'deleted' });
    const query = toSql(where.mock.calls[0]?.[0]);
    expect(query?.sql).toContain('"claims"."version" = $3');
    expect(query?.params).toEqual([claimId, candidateId, 3]);
  });

  it('reports a conflict when the claim has another version', async () => {
    const { database } = createDeleteDatabase([], [claimRow(4)]);

    await expect(
      createCandidatesRepository(database).deleteClaim(candidateId, claimId, 3)
    ).resolves.toMatchObject({ status: 'conflict', current: { version: 4 } });
  });

  it('reports a missing claim', async () => {
    const { database } = createDeleteDatabase([], []);

    await expect(
      createCandidatesRepository(database).deleteClaim(candidateId, claimId)
    ).resolves.toEqual({ status: 'missing' });
  });
});

describe('updating a profile', () => {
  const profile = { candidateId, version: 4 } as CandidateRecord;

  function createProfileDatabase(updated: unknown[], current: unknown[]) {
    const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
    const where = vi.fn<(condition: SQL) => unknown>(() => ({
      returning: () => Promise.resolve(updated)
    }));
    const database = {
      db: {
        update: () => ({ set }),
        select: () => ({
          from: () => ({ where: () => ({ limit: () => Promise.resolve(current) }) })
        })
      }
    } as unknown as AppDatabase;
    return { database, set, where };
  }

  it('increases the version and checks the expected one', async () => {
    const { database, set, where } = createProfileDatabase([profile], []);

    await expect(
      createCandidatesRepository(database).updateCandidate(
        candidateId,
        { headline: 'Engineer' },
        3
      )
    ).resolves.toEqual({ status: 'saved', record: profile });
    expect(set.mock.calls[0]?.[0]).toMatchObject({ headline: 'Engineer' });
    expect(toSql(set.mock.calls[0]?.[0].version as SQL)?.sql).toBe(
      '"candidates"."version" + 1'
    );
    expect(toSql(where.mock.calls[0]?.[0])?.params).toEqual([candidateId, 3]);
  });

  it('reports a conflict with the current profile', async () => {
    const { database } = createProfileDatabase([], [profile]);

    await expect(
      createCandidatesRepository(database).updateCandidate(candidateId, {}, 3)
    ).resolves.toEqual({ status: 'conflict', current: profile });
  });

  it('reports a missing profile', async () => {
    const { database } = createProfileDatabase([], []);

    await expect(
      createCandidatesRepository(database).updateCandidate(candidateId, {})
    ).resolves.toEqual({ status: 'missing' });
  });
});

describe('retrying claim transactions', () => {
  // The transaction work is not run: these tests only check how a failed
  // transaction is handled.
  function createDatabase(...outcomes: unknown[]) {
    const transaction = vi.fn(() => {
      const outcome = outcomes.shift();
      return outcome && typeof outcome === 'object' && 'code' in outcome
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    });

    return {
      database: { db: { transaction } } as unknown as AppDatabase,
      transaction
    };
  }

  const saved = { status: 'saved', record: claim };
  const edit = { candidateId, claimId, values: { name: 'TypeScript' } };

  it('runs claim creation again after a deadlock', async () => {
    const { database, transaction } = createDatabase(deadlock, claim);

    await expect(
      createCandidatesRepository(database).createClaim({
        candidateId,
        claimType: 'skill',
        origin: 'manual',
        status: 'accepted',
        values: { name: 'TypeScript' }
      })
    ).resolves.toBe(claim);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('runs a claim edit again after a deadlock', async () => {
    const { database, transaction } = createDatabase(deadlock, saved);

    await expect(
      createCandidatesRepository(database).updateClaimValues(edit)
    ).resolves.toBe(saved);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry other database errors', async () => {
    const { database, transaction } = createDatabase(uniqueViolation);

    await expect(
      createCandidatesRepository(database).updateClaimValues(edit)
    ).rejects.toMatchObject({ code: 'UNIQUE_CONSTRAINT_VIOLATION' });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('reports a transient error after three attempts', async () => {
    const { database, transaction } = createDatabase(deadlock, deadlock, deadlock);

    await expect(
      createCandidatesRepository(database).updateClaimValues(edit)
    ).rejects.toMatchObject({ statusCode: 503, code: 'TRANSIENT_DATABASE_ERROR' });
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});

describe('creating a claim with extraction provenance', () => {
  function creationContext(row: unknown) {
    const returning = vi.fn().mockResolvedValue([{ claimId }]);
    const claimValues = vi.fn(() => ({ returning }));
    const detailValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn((table: unknown) => ({
      values: table === claims ? claimValues : detailValues
    }));
    const readQuery = {
      leftJoin: () => readQuery,
      where: () => ({ orderBy: () => Promise.resolve([row]) })
    };
    const select = vi.fn(() => ({ from: () => readQuery }));
    const databaseTransaction = vi.fn();
    const repository = createCandidatesRepository({
      db: { transaction: databaseTransaction }
    } as unknown as AppDatabase);
    const transaction = { insert, select } as unknown as DatabaseExecutor;

    return { claimValues, databaseTransaction, repository, transaction };
  }

  it('stores and returns extracted evidence and its source document', async () => {
    const extraction = {
      invocationId: '33333333-3333-4333-8333-333333333333',
      sourceDocumentId: '44444444-4444-4444-8444-444444444444',
      rawValues: { name: 'TypeScript' },
      fieldSources: { name: ['L12'] },
      current: false
    };
    const extractedRow = {
      ...claimRow(1),
      claim: {
        ...claimRow(1).claim,
        origin: 'extracted' as const,
        status: 'pending' as const,
        extractionInvocationId: extraction.invocationId,
        extractionDocumentId: extraction.sourceDocumentId,
        extractionRawValues: extraction.rawValues,
        extractionFieldSources: extraction.fieldSources,
        extractionCurrent: extraction.current
      }
    };
    const { claimValues, databaseTransaction, repository, transaction } =
      creationContext(extractedRow);

    await expect(
      repository.createClaim(
        {
          candidateId,
          claimType: 'skill',
          origin: 'extracted',
          status: 'pending',
          values: { name: 'TypeScript' },
          extraction
        },
        transaction
      )
    ).resolves.toMatchObject({
      origin: 'extracted',
      extraction
    });
    expect(claimValues).toHaveBeenCalledWith({
      candidateId,
      claimType: 'skill',
      origin: 'extracted',
      status: 'pending',
      extractionInvocationId: extraction.invocationId,
      extractionDocumentId: extraction.sourceDocumentId,
      extractionRawValues: extraction.rawValues,
      extractionFieldSources: extraction.fieldSources,
      extractionCurrent: false
    });
    expect(databaseTransaction).not.toHaveBeenCalled();
  });

  it('keeps extraction provenance null for a manual claim', async () => {
    const { claimValues, repository, transaction } = creationContext(claimRow(1));

    await repository.createClaim(
      {
        candidateId,
        claimType: 'skill',
        origin: 'manual',
        status: 'accepted',
        values: { name: 'TypeScript' }
      },
      transaction
    );

    expect(claimValues).toHaveBeenCalledWith({
      candidateId,
      claimType: 'skill',
      origin: 'manual',
      status: 'accepted',
      extractionInvocationId: null,
      extractionDocumentId: null,
      extractionRawValues: null,
      extractionFieldSources: null,
      extractionCurrent: null
    });
  });
});

describe('creating claims in a batch', () => {
  function batchContext() {
    const claimRows: (typeof claims.$inferInsert)[] = [];
    const skillRows: (typeof skillDetails.$inferInsert)[] = [];
    const employmentRows: (typeof employmentDetails.$inferInsert)[] = [];

    const insert = vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === claims) {
          claimRows.push(...(rows as (typeof claims.$inferInsert)[]));
        } else if (table === skillDetails) {
          skillRows.push(...(rows as (typeof skillDetails.$inferInsert)[]));
        } else if (table === employmentDetails) {
          employmentRows.push(
            ...(rows as (typeof employmentDetails.$inferInsert)[])
          );
        }
      })
    }));
    const readQuery = {
      leftJoin: () => readQuery,
      where: () => ({
        orderBy: () =>
          Promise.resolve(
            [...claimRows].reverse().map((storedClaim) => ({
              claim: {
                ...storedClaim,
                version: 1,
                createdAt: timestamp,
                updatedAt: timestamp
              },
              skill:
                skillRows.find(
                  (row) => row.claimId === storedClaim.claimId
                ) ?? null,
              employment:
                employmentRows.find(
                  (row) => row.claimId === storedClaim.claimId
                ) ?? null,
              education: null,
              certification: null,
              language: null,
              project: null
            }))
          )
      })
    };
    const select = vi.fn(() => ({ from: () => readQuery }));
    const transaction = { insert, select } as unknown as DatabaseExecutor;
    const repository = createCandidatesRepository({} as AppDatabase);

    return {
      claimRows,
      employmentRows,
      insert,
      repository,
      select,
      skillRows,
      transaction
    };
  }

  it('bulk-inserts base and grouped detail rows and preserves input order', async () => {
    const context = batchContext();
    const extraction = {
      invocationId: '33333333-3333-4333-8333-333333333333',
      sourceDocumentId: '44444444-4444-4444-8444-444444444444',
      rawValues: {},
      fieldSources: {},
      current: false
    };

    const created = await context.repository.createClaims(
      [
        {
          candidateId,
          claimType: 'skill',
          origin: 'extracted',
          status: 'pending',
          values: { name: 'TypeScript' },
          extraction
        },
        {
          candidateId,
          claimType: 'employment',
          origin: 'extracted',
          status: 'pending',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2024-01'
          },
          extraction
        }
      ],
      context.transaction
    );

    expect(context.insert).toHaveBeenCalledTimes(3);
    expect(context.claimRows).toHaveLength(2);
    expect(context.skillRows).toEqual([
      {
        claimId: context.claimRows[0]!.claimId,
        name: 'TypeScript'
      }
    ]);
    expect(context.employmentRows).toEqual([
      expect.objectContaining({
        claimId: context.claimRows[1]!.claimId,
        employer: 'Example Labs',
        startDate: '2024-01-01'
      })
    ]);
    expect(created.map(({ claimType }) => claimType)).toEqual([
      'skill',
      'employment'
    ]);
  });

  it('does not query the database for an empty batch', async () => {
    const context = batchContext();

    await expect(
      context.repository.createClaims([], context.transaction)
    ).resolves.toEqual([]);
    expect(context.insert).not.toHaveBeenCalled();
    expect(context.select).not.toHaveBeenCalled();
  });
});

describe('creating claim source occurrences', () => {
  it('bulk-inserts physical evidence through the caller transaction', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn((table: unknown) => {
      expect(table).toBe(sourceOccurrences);
      return { values };
    });
    const transaction = { insert } as unknown as DatabaseExecutor;
    const repository = createCandidatesRepository({} as AppDatabase);
    const inputs = [
      {
        claimId,
        documentId: '44444444-4444-4444-8444-444444444444',
        anchorKey: 'pdf:1:8',
        sourceReferences: ['L8'],
        fieldNames: ['name'],
        anchor: {
          kind: 'pdf_line' as const,
          order: 8,
          pageNumber: 1,
          box: { x: 40, y: 80, width: 100, height: 12 },
          text: 'TypeScript',
          links: []
        }
      }
    ];

    await expect(
      repository.createClaimSourceOccurrences(inputs, transaction)
    ).resolves.toBe(1);
    expect(values).toHaveBeenCalledWith(inputs);
  });
});

describe('replacing pending extracted claims', () => {
  it('deletes only the candidate and source document pending set', async () => {
    const documentId = '44444444-4444-4444-8444-444444444444';
    const returning = vi.fn().mockResolvedValue([{ claimId }, { claimId: 'other' }]);
    const where = vi.fn((_condition: SQL) => ({ returning }));
    const transaction = {
      delete: vi.fn(() => ({ where }))
    } as unknown as DatabaseExecutor;
    const repository = createCandidatesRepository({} as AppDatabase);

    await expect(
      repository.deletePendingExtractedClaims(
        candidateId,
        documentId,
        transaction
      )
    ).resolves.toBe(2);

    const query = toSql(where.mock.calls[0]?.[0]);
    expect(query?.sql).toContain('"claims"."candidate_id" = $1');
    expect(query?.sql).toContain('"claims"."origin" = $2');
    expect(query?.sql).toContain('"claims"."status" = $3');
    expect(query?.sql).toContain('"claims"."extraction_document_id" = $4');
    expect(query?.params).toEqual([
      candidateId,
      'extracted',
      'pending',
      documentId
    ]);
  });

  it('loads only reviewed extracted claims for the candidate and document', async () => {
    const documentId = '44444444-4444-4444-8444-444444444444';
    const orderBy = vi.fn().mockResolvedValue([]);
    const where = vi.fn((_condition: SQL) => ({ orderBy }));
    const readQuery = {
      leftJoin: () => readQuery,
      where
    };
    const transaction = {
      select: vi.fn(() => ({ from: () => readQuery }))
    } as unknown as DatabaseExecutor;
    const repository = createCandidatesRepository({} as AppDatabase);

    await expect(
      repository.listReviewedExtractedClaims(
        candidateId,
        documentId,
        transaction
      )
    ).resolves.toEqual([]);

    const query = toSql(where.mock.calls[0]?.[0]);
    expect(query?.sql).toContain('"claims"."candidate_id" = $1');
    expect(query?.sql).toContain('"claims"."origin" = $2');
    expect(query?.sql).toContain(
      '"claims"."status" in ($3, $4)'
    );
    expect(query?.sql).toContain(
      '"claims"."extraction_document_id" = $5'
    );
    expect(query?.params).toEqual([
      candidateId,
      'extracted',
      'accepted',
      'rejected',
      documentId
    ]);
  });
});

describe('reviewing an extracted claim', () => {
  it('guards the status transition by owner, origin, state, and version', async () => {
    const reviewedRow = {
      ...claimRow(2),
      claim: {
        ...claimRow(2).claim,
        origin: 'extracted' as const,
        status: 'accepted' as const,
        extractionInvocationId: '44444444-4444-4444-8444-444444444444',
        extractionDocumentId: '55555555-5555-4555-8555-555555555555',
        extractionRawValues: {},
        extractionFieldSources: { name: ['L8'] },
        extractionCurrent: false
      }
    };
    const returning = vi.fn().mockResolvedValue([{ claimId }]);
    const where = vi.fn((_condition: SQL) => ({ returning }));
    const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
    const readQuery = {
      leftJoin: () => readQuery,
      where: () => ({ orderBy: () => Promise.resolve([reviewedRow]) })
    };
    const database = {
      db: {
        update: vi.fn(() => ({ set })),
        select: vi.fn(() => ({ from: () => readQuery }))
      }
    } as unknown as AppDatabase;

    await expect(
      createCandidatesRepository(database).reviewExtractedClaim(
        candidateId,
        claimId,
        'accepted',
        1
      )
    ).resolves.toMatchObject({
      status: 'saved',
      record: { status: 'accepted', version: 2 }
    });

    const update = set.mock.calls[0]?.[0];
    expect(update?.status).toBe('accepted');
    expect(toSql(update?.version as SQL)?.sql).toBe('"claims"."version" + 1');
    const query = toSql(where.mock.calls[0]?.[0]);
    expect(query?.params).toEqual([
      candidateId,
      claimId,
      'extracted',
      'pending',
      1
    ]);
  });
});
