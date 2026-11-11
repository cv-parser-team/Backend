import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import {
  type CandidateRecord,
  type ClaimRecord,
  createCandidatesRepository
} from './candidates.repository.js';
import { claimRevisions, claims } from './candidates.table.js';

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
