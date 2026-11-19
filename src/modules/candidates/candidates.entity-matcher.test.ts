import { describe, expect, it, vi } from 'vitest';
import { createCandidateEntityMatcher } from './candidates.entity-matcher.js';
import type { CandidateRecord, ClaimRecord } from './candidates.repository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const candidate = { candidateId: '22222222-2222-4222-8222-222222222222' } as CandidateRecord;
const timestamp = new Date('2026-01-01T00:00:00.000Z');
let nextClaim = 0;

function claim(
  claimType: ClaimRecord['claimType'],
  values: ClaimRecord['values'],
  overrides: Partial<ClaimRecord> = {}
): ClaimRecord {
  nextClaim += 1;
  return {
    claimId: `00000000-0000-4000-8000-${String(nextClaim).padStart(12, '0')}`,
    supersededByClaimId: null,
    claimType,
    origin: 'extracted',
    status: 'accepted',
    current: false,
    candidateEdited: false,
    values,
    extraction: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  } as ClaimRecord;
}

function matcherWith(
  claims: ClaimRecord[],
  termLookup?: Parameters<typeof createCandidateEntityMatcher>[0]['termLookup']
) {
  const repository = {
    findCandidateByUserId: vi.fn().mockResolvedValue(candidate),
    listClaims: vi.fn().mockResolvedValue(claims)
  };
  return createCandidateEntityMatcher({ repository, ...(termLookup ? { termLookup } : {}) });
}

const cedar = {
  jobTitle: 'Junior Software Developer',
  startDate: '2020-06',
  endDate: '2021-12'
};

describe('finding the claims an unsaved fact states again', () => {
  it('matches a fact to a claim by the duplicate-claim rules', async () => {
    const saved = claim('employment', { ...cedar, employer: 'Cedar Systems' });
    const matches = await matcherWith([saved]).findSameEntities(userId, [
      {
        key: 'review-1',
        claimType: 'employment',
        values: { ...cedar, employer: 'Cedar Sytems' },
        current: false
      }
    ]);

    expect(matches.get('review-1')).toEqual({ claimIds: [saved.claimId], keys: [] });
  });

  it('matches unsaved facts that state the same fact as each other', async () => {
    const matches = await matcherWith([]).findSameEntities(userId, [
      { key: 'a', claimType: 'employment', values: { ...cedar, employer: 'Cedar Systems' }, current: false },
      { key: 'b', claimType: 'employment', values: { ...cedar, employer: 'Cedar Sytems' }, current: false },
      { key: 'c', claimType: 'employment', values: { ...cedar, employer: 'Northstar Labs' }, current: false }
    ]);

    expect(matches.get('a')).toEqual({ claimIds: [], keys: ['b'] });
    expect(matches.get('b')).toEqual({ claimIds: [], keys: ['a'] });
    expect(matches.has('c')).toBe(false);
  });

  it('compares values linked to one canonical term as the same value', async () => {
    const saved = claim('skill', { name: 'PostgreSQL' });
    const termLookup = {
      findDictionaryTerms: vi.fn().mockResolvedValue([{ name: 't-pg' }]),
      findNormalizedTerms: vi.fn().mockResolvedValue(new Map([[saved.claimId, { name: 't-pg' }]]))
    };

    const withTerms = await matcherWith([saved], termLookup).findSameEntities(userId, [
      { key: 'review-1', claimType: 'skill', values: { name: 'Postgres' }, current: false }
    ]);
    const withoutTerms = await matcherWith([saved]).findSameEntities(userId, [
      { key: 'review-1', claimType: 'skill', values: { name: 'Postgres' }, current: false }
    ]);

    expect(withTerms.get('review-1')?.claimIds).toEqual([saved.claimId]);
    expect(withoutTerms.size).toBe(0);
  });

  it('ignores rejected and merged claims', async () => {
    const matches = await matcherWith([
      claim('skill', { name: 'Python' }, { status: 'rejected' }),
      claim('skill', { name: 'Python' }, { supersededByClaimId: 'merged-into' })
    ]).findSameEntities(userId, [
      { key: 'review-1', claimType: 'skill', values: { name: 'Python' }, current: false }
    ]);

    expect(matches.size).toBe(0);
  });

  it('compares written values when terms cannot be loaded', async () => {
    const saved = claim('skill', { name: 'Python' });
    const termLookup = {
      findDictionaryTerms: vi.fn().mockRejectedValue(new Error('offline')),
      findNormalizedTerms: vi.fn().mockResolvedValue(new Map())
    };

    const matches = await matcherWith([saved], termLookup).findSameEntities(userId, [
      { key: 'review-1', claimType: 'skill', values: { name: 'python' }, current: false }
    ]);

    expect(matches.get('review-1')?.claimIds).toEqual([saved.claimId]);
  });

  it('finds nothing for a user without a candidate profile', async () => {
    const repository = {
      findCandidateByUserId: vi.fn().mockResolvedValue(null),
      listClaims: vi.fn()
    };

    const matches = await createCandidateEntityMatcher({ repository }).findSameEntities(userId, [
      { key: 'review-1', claimType: 'skill', values: { name: 'Python' }, current: false }
    ]);

    expect(matches.size).toBe(0);
    expect(repository.listClaims).not.toHaveBeenCalled();
  });
});
