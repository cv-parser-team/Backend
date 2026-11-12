import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import {
  createCandidateExtractionWriter,
  type CandidateExtractionWriterDependencies,
  type ExtractedClaimDraftInput
} from './candidates.extraction-writer.js';
import type {
  CandidateRecord,
  ClaimRecord
} from './candidates.repository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const invocationId = '33333333-3333-4333-8333-333333333333';
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const transaction = {} as DatabaseExecutor;
const candidate = { candidateId } as CandidateRecord;

function dependencies(foundCandidate: CandidateRecord | null) {
  const findCandidateByUserId = vi.fn().mockResolvedValue(foundCandidate);
  const createClaim = vi.fn().mockImplementation(async (input) => ({
    claimId: randomUUID(),
    claimType: input.claimType,
    origin: input.origin,
    status: input.status,
    values: input.values,
    extraction: input.extraction,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  } satisfies ClaimRecord));
  const repository = {
    findCandidateByUserId,
    createClaim
  } as CandidateExtractionWriterDependencies['repository'];

  return {
    findCandidateByUserId,
    createClaim,
    writer: createCandidateExtractionWriter({ repository })
  };
}

describe('candidate extraction writer', () => {
  it('saves every pending draft with its evidence in the same transaction', async () => {
    const { createClaim, findCandidateByUserId, writer } = dependencies(candidate);
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'skill',
        values: { name: 'TypeScript' },
        rawValues: {},
        fieldSources: { name: ['L9'] },
        current: false
      },
      {
        type: 'employment',
        values: {
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2022-01'
        },
        rawValues: { startDate: 'January 2022' },
        fieldSources: {
          employer: ['L5'],
          jobTitle: ['L5'],
          startDate: ['L6']
        },
        current: true
      }
    ];

    await expect(
      writer.saveExtractedClaims(userId, invocationId, drafts, transaction)
    ).resolves.toHaveLength(2);
    expect(findCandidateByUserId).toHaveBeenCalledWith(userId, transaction);
    expect(createClaim).toHaveBeenNthCalledWith(
      2,
      {
        candidateId,
        claimType: 'employment',
        origin: 'extracted',
        status: 'pending',
        values: drafts[1]!.values,
        extraction: {
          invocationId,
          rawValues: drafts[1]!.rawValues,
          fieldSources: drafts[1]!.fieldSources,
          current: true
        }
      },
      transaction
    );
  });

  it('writes nothing when the user has no candidate profile', async () => {
    const { createClaim, writer } = dependencies(null);

    await expect(
      writer.saveExtractedClaims(userId, invocationId, [], transaction)
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(createClaim).not.toHaveBeenCalled();
  });
});
