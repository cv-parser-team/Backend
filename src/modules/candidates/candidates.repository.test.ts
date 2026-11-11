import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import { createCandidatesRepository } from './candidates.repository.js';

const candidateId = '11111111-1111-4111-8111-111111111111';
const deadlock = { code: '40P01', message: 'deadlock detected' };
const uniqueViolation = { code: '23505', message: 'duplicate key' };

// The transaction work itself is not run: these tests only check how a failed
// transaction is handled.
function createDatabase(...outcomes: unknown[]) {
  const transaction = vi.fn(() => {
    const outcome = outcomes.shift();
    return outcome instanceof Error || (outcome && typeof outcome === 'object' && 'code' in outcome)
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  });

  return {
    database: { db: { transaction } } as unknown as AppDatabase,
    transaction
  };
}

const claim = {
  claimId: '22222222-2222-4222-8222-222222222222',
  claimType: 'skill' as const,
  origin: 'manual' as const,
  status: 'accepted' as const,
  values: { name: 'TypeScript' },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z')
};

describe('candidates repository transactions', () => {
  it('runs claim creation again after a deadlock', async () => {
    const { database, transaction } = createDatabase(deadlock, claim);
    const repository = createCandidatesRepository(database);

    await expect(
      repository.createClaim({
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
    const { database, transaction } = createDatabase(deadlock, claim);
    const repository = createCandidatesRepository(database);

    await expect(
      repository.updateClaimValues({
        candidateId,
        claimId: claim.claimId,
        values: { name: 'TypeScript' }
      })
    ).resolves.toBe(claim);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry other database errors', async () => {
    const { database, transaction } = createDatabase(uniqueViolation);
    const repository = createCandidatesRepository(database);

    await expect(
      repository.updateClaimValues({
        candidateId,
        claimId: claim.claimId,
        values: { name: 'TypeScript' }
      })
    ).rejects.toMatchObject({ code: 'UNIQUE_CONSTRAINT_VIOLATION' });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('reports a transient error after three attempts', async () => {
    const { database, transaction } = createDatabase(deadlock, deadlock, deadlock);
    const repository = createCandidatesRepository(database);

    await expect(
      repository.updateClaimValues({
        candidateId,
        claimId: claim.claimId,
        values: { name: 'TypeScript' }
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'TRANSIENT_DATABASE_ERROR' });
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
