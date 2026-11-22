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
  claimAutoMergeNotices,
  claimPairDecisions,
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
  supersededByClaimId: null,
  claimType: 'skill',
  origin: 'manual',
  status: 'accepted',
  current: false,
  candidateEdited: false,
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
      supersededByClaimId: null,
      candidateId,
      claimType: 'skill',
      origin: 'manual',
      status: 'accepted',
      current: false,
      candidateEditedAt: null,
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
      previousValues: { name: 'TypeScript' },
      previousCurrent: false
    });
    const versionUpdate = tx.claimUpdates[0]?.version as SQL | undefined;
    expect(toSql(versionUpdate)?.sql).toBe('"claims"."version" + 1');
    expect(tx.claimUpdates[0]).not.toHaveProperty('candidateEditedAt');
  });

  it('marks an extracted claim as candidate-edited without changing its origin', async () => {
    const beforeRow = claimRow(1);
    const before = {
      ...beforeRow,
      claim: { ...beforeRow.claim, origin: 'extracted' as const }
    };
    const afterRow = claimRow(2, 'Node.js');
    const after = {
      ...afterRow,
      claim: {
        ...afterRow.claim,
        origin: 'extracted' as const,
        candidateEditedAt: timestamp
      }
    };
    const tx = createClaimTransaction([{ claimId }], [[before], [after]]);
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    await expect(repository.updateClaimValues(edit(1))).resolves.toMatchObject({
      status: 'saved',
      record: { origin: 'extracted', candidateEdited: true }
    });

    expect(tx.claimUpdates[0]?.candidateEditedAt).toBeInstanceOf(Date);
  });

  it('approves an automatic merge when its result is edited', async () => {
    const beforeRow = claimRow(1);
    const before = {
      ...beforeRow,
      claim: { ...beforeRow.claim, status: 'auto_accepted' as const }
    };
    const tx = createClaimTransaction(
      [{ claimId }],
      [[before], [claimRow(2, 'Node.js')]]
    );
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    await expect(repository.updateClaimValues(edit(1))).resolves.toMatchObject({
      status: 'saved'
    });

    expect(tx.claimUpdates[0]).toMatchObject({ status: 'accepted' });
    expect(tx.update).toHaveBeenCalledWith(claimAutoMergeNotices);
  });

  it('leaves the status and merge notices of other claims alone', async () => {
    const tx = createClaimTransaction(
      [{ claimId }],
      [[claimRow(1)], [claimRow(2, 'Node.js')]]
    );
    const repository = createCandidatesRepository(databaseWith(tx.transaction));

    await repository.updateClaimValues(edit(1));

    expect(tx.claimUpdates[0]).not.toHaveProperty('status');
    expect(tx.update).not.toHaveBeenCalledWith(claimAutoMergeNotices);
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
      current: true
    };
    const extractedRow = {
      ...claimRow(1),
      claim: {
        ...claimRow(1).claim,
        origin: 'extracted' as const,
        status: 'pending' as const,
        current: extraction.current,
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
      current: true,
      extraction
    });
    expect(claimValues).toHaveBeenCalledWith({
      candidateId,
      claimType: 'skill',
      origin: 'extracted',
      status: 'pending',
      current: true,
      extractionInvocationId: extraction.invocationId,
      extractionDocumentId: extraction.sourceDocumentId,
      extractionRawValues: extraction.rawValues,
      extractionFieldSources: extraction.fieldSources,
      extractionCurrent: true
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
      current: false,
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
            startDate: '2024',
            endDate: '2026'
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
        startDate: '2024-01-01',
        startDatePrecision: 'year',
        endDate: '2026-12-01',
        endDatePrecision: 'year'
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
    const returning = vi.fn().mockResolvedValue([{ occurrenceId: 'occurrence-1' }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
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
    expect(onConflictDoNothing).toHaveBeenCalled();
  });
});

describe('transferring claim source occurrences', () => {
  it('skips matching physical evidence and moves distinct documents', async () => {
    const survivorClaimId = '33333333-3333-4333-8333-333333333333';
    const firstDocumentId = '44444444-4444-4444-8444-444444444444';
    const secondDocumentId = '55555555-5555-4555-8555-555555555555';
    const duplicateOccurrenceId = '66666666-6666-4666-8666-666666666666';
    const distinctOccurrenceId = '77777777-7777-4777-8777-777777777777';
    const selectWhere = vi.fn().mockResolvedValue([
      {
        occurrenceId: '88888888-8888-4888-8888-888888888888',
        claimId: survivorClaimId,
        documentId: firstDocumentId,
        anchorKey: 'pdf:1:8'
      },
      {
        occurrenceId: duplicateOccurrenceId,
        claimId,
        documentId: firstDocumentId,
        anchorKey: 'pdf:1:8'
      },
      {
        occurrenceId: distinctOccurrenceId,
        claimId,
        documentId: secondDocumentId,
        anchorKey: 'pdf:1:8'
      }
    ]);
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const updateReturning = vi
      .fn()
      .mockResolvedValue([{ occurrenceId: distinctOccurrenceId }]);
    const updateWhere = vi.fn<(condition: SQL) => unknown>(() => ({
      returning: updateReturning
    }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const transaction = {
      select: vi.fn(() => ({
        from: () => ({ where: selectWhere })
      })),
      delete: vi.fn(() => ({ where: deleteWhere })),
      update: vi.fn(() => ({ set: updateSet }))
    } as unknown as DatabaseExecutor;
    const repository = createCandidatesRepository({} as AppDatabase);

    await expect(
      repository.transferClaimSourceOccurrences(
        claimId,
        survivorClaimId,
        transaction
      )
    ).resolves.toEqual({ moved: 1, skipped: 1 });

    expect(toSql(deleteWhere.mock.calls[0]?.[0])?.params).toEqual([
      duplicateOccurrenceId
    ]);
    expect(updateSet).toHaveBeenCalledWith({ claimId: survivorClaimId });
    expect(toSql(updateWhere.mock.calls[0]?.[0])?.params).toEqual([claimId]);
  });
});

describe('atomic claim merging', () => {
  const duplicateClaimId = '33333333-3333-4333-8333-333333333333';

  function pendingRow(
    rowClaimId: string,
    version: number,
    name: string,
    supersededByClaimId: string | null = null
  ) {
    const row = claimRow(version, name);
    return {
      ...row,
      claim: {
        ...row.claim,
        claimId: rowClaimId,
        supersededByClaimId,
        origin: 'extracted' as const,
        status: 'pending' as const,
        extractionInvocationId: '44444444-4444-4444-8444-444444444444',
        extractionDocumentId: '55555555-5555-4555-8555-555555555555',
        extractionRawValues: { name },
        extractionFieldSources: { name: ['L8'] },
        extractionCurrent: false
      },
      skill: { claimId: rowClaimId, name }
    };
  }

  function coalesceContext(
    reads: unknown[][],
    lockedClaimIds = [claimId, duplicateClaimId]
  ) {
    const lock = vi.fn().mockResolvedValue([
      ...lockedClaimIds.map((lockedClaimId) => ({ claimId: lockedClaimId }))
    ]);
    const lockOrderBy = vi.fn(() => ({ for: lock }));
    const lockWhere = vi.fn(() => ({ orderBy: lockOrderBy }));
    const read = vi.fn().mockImplementation(() =>
      Promise.resolve(reads.shift() ?? [])
    );
    const readQuery = {
      leftJoin: () => readQuery,
      where: () => ({ orderBy: read })
    };
    const occurrenceWhere = vi.fn().mockResolvedValue([]);
    const select = vi.fn((fields: Record<string, unknown>) => ({
      from: () =>
        'claim' in fields
          ? readQuery
          : 'occurrenceId' in fields
            ? { where: occurrenceWhere }
            : { where: lockWhere }
    }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const inserted = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values: inserted }));
    const claimUpdates: Record<string, unknown>[] = [];
    const detailUpdates: Record<string, unknown>[] = [];
    const update = vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        (table === claims ? claimUpdates : detailUpdates).push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }
    }));
    const transaction = {
      select,
      insert,
      update,
      delete: vi.fn()
    };
    const database = {
      db: {
        transaction: (work: (value: unknown) => Promise<unknown>) =>
          work(transaction)
      }
    } as unknown as AppDatabase;
    return {
      claimUpdates,
      detailUpdates,
      inserted,
      lock,
      lockOrderBy,
      onConflictDoUpdate,
      repository: createCandidatesRepository(database),
      update
    };
  }

  it('updates the pending survivor and retires the duplicate atomically', async () => {
    const before = [
      pendingRow(claimId, 2, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript')
    ];
    const after = [
      {
        ...pendingRow(claimId, 3, 'TypeScript and Node.js'),
        claim: {
          ...pendingRow(claimId, 3, 'TypeScript and Node.js').claim,
          status: 'auto_accepted' as const
        }
      },
      pendingRow(duplicateClaimId, 5, 'typescript', claimId)
    ];
    const context = coalesceContext([before, after]);

    await expect(
      context.repository.coalescePendingClaims({
        candidateId,
        survivor: { claimId, expectedVersion: 2 },
        duplicate: { claimId: duplicateClaimId, expectedVersion: 4 },
        values: { name: 'TypeScript and Node.js' },
        current: false,
        messages: []
      })
    ).resolves.toMatchObject({
      status: 'saved',
      survivor: { claimId, status: 'auto_accepted', version: 3 },
      duplicate: { supersededByClaimId: claimId, version: 5 }
    });

    expect(context.lock).toHaveBeenCalledWith('update');
    expect(context.lockOrderBy).toHaveBeenCalledOnce();
    expect(context.inserted).toHaveBeenCalledWith({
      claimId,
      previousValues: { name: 'TypeScript' },
      previousCurrent: false
    });
    expect(context.inserted).toHaveBeenCalledWith(
      expect.objectContaining({
        survivorClaimId: claimId,
        supersededClaimIds: [duplicateClaimId],
        claimsBefore: [
          expect.objectContaining({
            claimId,
            values: { name: 'TypeScript' },
            sourceDocumentId: '55555555-5555-4555-8555-555555555555'
          }),
          expect.objectContaining({
            claimId: duplicateClaimId,
            values: { name: 'typescript' },
            sourceDocumentId: '55555555-5555-4555-8555-555555555555'
          })
        ]
      })
    );
    expect(context.detailUpdates).toContainEqual({
      name: 'TypeScript and Node.js'
    });
    expect(context.claimUpdates).toEqual([
      expect.objectContaining({ current: false }),
      expect.objectContaining({ supersededByClaimId: claimId })
    ]);
  });

  it('refuses stale versions before writing', async () => {
    const before = [
      pendingRow(claimId, 3, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript')
    ];
    const context = coalesceContext([before]);

    await expect(
      context.repository.coalescePendingClaims({
        candidateId,
        survivor: { claimId, expectedVersion: 2 },
        duplicate: { claimId: duplicateClaimId, expectedVersion: 4 },
        values: { name: 'TypeScript' },
        messages: []
      })
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(context.inserted).not.toHaveBeenCalled();
    expect(context.update).not.toHaveBeenCalled();
  });

  it('accepts the confirmed survivor and retires its duplicate atomically', async () => {
    const before = [
      pendingRow(claimId, 2, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript')
    ];
    const savedSurvivor = pendingRow(claimId, 3, 'TypeScript and Node.js');
    const acceptedSurvivor = {
      ...savedSurvivor,
      claim: { ...savedSurvivor.claim, status: 'accepted' as const }
    };
    const after = [
      acceptedSurvivor,
      pendingRow(duplicateClaimId, 5, 'typescript', claimId)
    ];
    const context = coalesceContext([before, after]);

    await expect(
      context.repository.mergeConfirmedClaims({
        candidateId,
        survivor: { claimId, expectedVersion: 2 },
        duplicate: { claimId: duplicateClaimId, expectedVersion: 4 },
        values: { name: 'TypeScript and Node.js' }
      })
    ).resolves.toMatchObject({
      status: 'saved',
      survivor: { claimId, status: 'accepted', version: 3 },
      duplicate: { supersededByClaimId: claimId, version: 5 }
    });

    expect(context.lock).toHaveBeenCalledWith('update');
    expect(context.inserted).toHaveBeenCalledWith({
      claimId,
      previousValues: { name: 'TypeScript' },
      previousCurrent: false
    });
    expect(context.detailUpdates).toContainEqual({
      name: 'TypeScript and Node.js'
    });
    expect(context.claimUpdates).toEqual([
      expect.objectContaining({ status: 'accepted', current: false }),
      expect.objectContaining({ supersededByClaimId: claimId })
    ]);
  });

  it('refuses stale confirmed merges before writing', async () => {
    const before = [
      pendingRow(claimId, 3, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript')
    ];
    const context = coalesceContext([before]);

    await expect(
      context.repository.mergeConfirmedClaims({
        candidateId,
        survivor: { claimId, expectedVersion: 2 },
        duplicate: { claimId: duplicateClaimId, expectedVersion: 4 },
        values: { name: 'TypeScript' }
      })
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(context.inserted).not.toHaveBeenCalled();
    expect(context.update).not.toHaveBeenCalled();
  });

  it('accepts one survivor and retires a claim group atomically', async () => {
    const thirdClaimId = '44444444-4444-4444-8444-444444444444';
    const before = [
      pendingRow(claimId, 2, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript'),
      pendingRow(thirdClaimId, 3, 'TypeScript')
    ];
    const savedSurvivor = pendingRow(claimId, 3, 'TypeScript and Node.js');
    const after = [
      {
        ...savedSurvivor,
        claim: { ...savedSurvivor.claim, status: 'accepted' as const }
      },
      pendingRow(duplicateClaimId, 5, 'typescript', claimId),
      pendingRow(thirdClaimId, 4, 'TypeScript', claimId)
    ];
    const context = coalesceContext(
      [before, after],
      [claimId, duplicateClaimId, thirdClaimId]
    );

    await expect(
      context.repository.mergeConfirmedClaimGroup({
        candidateId,
        claims: [
          { claimId, expectedVersion: 2 },
          { claimId: duplicateClaimId, expectedVersion: 4 },
          { claimId: thirdClaimId, expectedVersion: 3 }
        ],
        survivorClaimId: claimId,
        values: { name: 'TypeScript and Node.js' }
      })
    ).resolves.toMatchObject({
      status: 'saved',
      survivor: { claimId, status: 'accepted', version: 3 },
      duplicates: [
        { claimId: duplicateClaimId, supersededByClaimId: claimId },
        { claimId: thirdClaimId, supersededByClaimId: claimId }
      ]
    });

    expect(context.lock).toHaveBeenCalledWith('update');
    expect(context.inserted).toHaveBeenCalledWith({
      claimId,
      previousValues: { name: 'TypeScript' },
      previousCurrent: false
    });
    expect(context.claimUpdates).toEqual([
      expect.objectContaining({ status: 'accepted', current: false }),
      expect.objectContaining({ supersededByClaimId: claimId })
    ]);
  });

  it('records a different decision using canonical claim order', async () => {
    const before = [
      pendingRow(claimId, 2, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript')
    ];
    const context = coalesceContext([before]);

    await expect(
      context.repository.recordClaimsDifferent({
        candidateId,
        left: { claimId: duplicateClaimId, expectedVersion: 4 },
        right: { claimId, expectedVersion: 2 }
      })
    ).resolves.toEqual({ status: 'saved' });

    expect(context.lock).toHaveBeenCalledWith('update');
    expect(context.inserted).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId,
        leftClaimId: claimId,
        rightClaimId: duplicateClaimId,
        leftVersion: 2,
        rightVersion: 4,
        decision: 'different'
      })
    );
    expect(context.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [
          claimPairDecisions.candidateId,
          claimPairDecisions.leftClaimId,
          claimPairDecisions.rightClaimId
        ],
        set: expect.objectContaining({
          leftVersion: 2,
          rightVersion: 4,
          decision: 'different'
        })
      })
    );
  });

  it('refuses stale different decisions before writing', async () => {
    const before = [
      pendingRow(claimId, 3, 'TypeScript'),
      pendingRow(duplicateClaimId, 4, 'typescript')
    ];
    const context = coalesceContext([before]);

    await expect(
      context.repository.recordClaimsDifferent({
        candidateId,
        left: { claimId, expectedVersion: 2 },
        right: { claimId: duplicateClaimId, expectedVersion: 4 }
      })
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(context.inserted).not.toHaveBeenCalled();
  });
});

describe('reading claim source occurrences', () => {
  it('loads accepted occurrences only for the candidate and requested claims', async () => {
    const otherClaimId = '33333333-3333-4333-8333-333333333333';
    const occurrence = {
      occurrenceId: '44444444-4444-4444-8444-444444444444',
      claimId,
      documentId: '55555555-5555-4555-8555-555555555555',
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
    };
    const orderBy = vi.fn().mockResolvedValue([{ occurrence }]);
    const where = vi.fn((_condition: SQL) => ({ orderBy }));
    const readQuery = {
      innerJoin: () => readQuery,
      where
    };
    const select = vi.fn(() => ({ from: () => readQuery }));
    const repository = createCandidatesRepository({
      db: { select }
    } as unknown as AppDatabase);

    await expect(
      repository.listClaimSourceOccurrences(candidateId, [claimId, otherClaimId])
    ).resolves.toEqual([occurrence]);

    const query = toSql(where.mock.calls[0]?.[0]);
    expect(query?.sql).toContain('"claims"."candidate_id" = $1');
    expect(query?.sql).toContain('"claims"."status" in ($2, $3)');
    expect(query?.sql).toContain('"claims"."superseded_by_claim_id" is null');
    expect(query?.sql).toContain('"claims"."claim_id" in ($4, $5)');
    expect(query?.params).toEqual([
      candidateId,
      'accepted',
      'auto_accepted',
      claimId,
      otherClaimId
    ]);
    expect(orderBy).toHaveBeenCalledOnce();
  });

  it('skips the database when there are no accepted claim IDs', async () => {
    const select = vi.fn();
    const repository = createCandidatesRepository({
      db: { select }
    } as unknown as AppDatabase);

    await expect(
      repository.listClaimSourceOccurrences(candidateId, [])
    ).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('reading claim pair decisions', () => {
  it('lists decisions for one candidate in canonical pair order', async () => {
    const decision = {
      decisionId: '44444444-4444-4444-8444-444444444444',
      candidateId,
      leftClaimId: claimId,
      rightClaimId: '33333333-3333-4333-8333-333333333333',
      leftVersion: 2,
      rightVersion: 4,
      decision: 'different' as const,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const orderBy = vi.fn().mockResolvedValue([decision]);
    const where = vi.fn((_condition: SQL) => ({ orderBy }));
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const repository = createCandidatesRepository({
      db: { select }
    } as unknown as AppDatabase);

    await expect(
      repository.listClaimPairDecisions(candidateId)
    ).resolves.toEqual([decision]);

    expect(toSql(where.mock.calls[0]?.[0])?.params).toEqual([candidateId]);
    expect(orderBy).toHaveBeenCalledOnce();
  });
});

describe('listing active claims', () => {
  it('excludes claims that were superseded by a merge', async () => {
    const orderBy = vi.fn().mockResolvedValue([]);
    const where = vi.fn((_condition: SQL) => ({ orderBy }));
    const readQuery = {
      leftJoin: () => readQuery,
      where
    };
    const repository = createCandidatesRepository({
      db: { select: () => ({ from: () => readQuery }) }
    } as unknown as AppDatabase);

    await expect(repository.listClaims(candidateId)).resolves.toEqual([]);

    const query = toSql(where.mock.calls[0]?.[0]);
    expect(query?.sql).toContain('"claims"."candidate_id" = $1');
    expect(query?.sql).toContain('"claims"."superseded_by_claim_id" is null');
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
    expect(query?.sql).toContain('"claims"."candidate_edited_at" is null');
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
    expect(query?.sql).toContain('"claims"."superseded_by_claim_id" is null');
  });
});
