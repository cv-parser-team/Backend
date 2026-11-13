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
const documentId = '44444444-4444-4444-8444-444444444444';
const timestamp = new Date('2026-01-01T00:00:00.000Z');
const transaction = {} as DatabaseExecutor;
const candidate = { candidateId } as CandidateRecord;

function dependencies(
  foundCandidate: CandidateRecord | null,
  reviewedClaims: ClaimRecord[] = []
) {
  const findCandidateByUserId = vi.fn().mockResolvedValue(foundCandidate);
  const deletePendingExtractedClaims = vi.fn().mockResolvedValue(0);
  const listReviewedExtractedClaims = vi
    .fn()
    .mockResolvedValue(reviewedClaims);
  const createClaims = vi
    .fn<CandidateExtractionWriterDependencies['repository']['createClaims']>()
    .mockImplementation(async (inputs) =>
      inputs.map((input) => ({
        claimId: randomUUID(),
        claimType: input.claimType,
        origin: input.origin,
        status: input.status,
        values: input.values,
        extraction: input.origin === 'extracted' ? input.extraction : null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      }))
    );
  const repository = {
    findCandidateByUserId,
    deletePendingExtractedClaims,
    listReviewedExtractedClaims,
    createClaims
  } as CandidateExtractionWriterDependencies['repository'];

  return {
    findCandidateByUserId,
    deletePendingExtractedClaims,
    listReviewedExtractedClaims,
    createClaims,
    writer: createCandidateExtractionWriter({ repository })
  };
}

describe('candidate extraction writer', () => {
  it('replaces same-document pending claims before saving new drafts', async () => {
    const {
      createClaims,
      deletePendingExtractedClaims,
      findCandidateByUserId,
      listReviewedExtractedClaims,
      writer
    } = dependencies(candidate);
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
      writer.saveExtractedClaims(
        userId,
        documentId,
        invocationId,
        drafts,
        transaction
      )
    ).resolves.toHaveLength(2);
    expect(findCandidateByUserId).toHaveBeenCalledWith(userId, transaction);
    expect(deletePendingExtractedClaims).toHaveBeenCalledWith(
      candidateId,
      documentId,
      transaction
    );
    expect(listReviewedExtractedClaims).toHaveBeenCalledWith(
      candidateId,
      documentId,
      transaction
    );
    expect(
      deletePendingExtractedClaims.mock.invocationCallOrder[0]
    ).toBeLessThan(createClaims.mock.invocationCallOrder[0]!);
    expect(createClaims).toHaveBeenCalledOnce();
    expect(createClaims).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          claimType: 'skill',
          values: drafts[0]!.values
        }),
        {
          candidateId,
          claimType: 'employment',
          origin: 'extracted',
          status: 'pending',
          values: drafts[1]!.values,
          extraction: {
            invocationId,
            sourceDocumentId: documentId,
            rawValues: drafts[1]!.rawValues,
            fieldSources: drafts[1]!.fieldSources,
            current: true
          }
        }
      ],
      transaction
    );
  });

  it('skips reviewed exact matches and saves changed or new drafts', async () => {
    const reviewedClaims: ClaimRecord[] = [
      {
        claimId: randomUUID(),
        claimType: 'employment',
        origin: 'extracted',
        status: 'accepted',
        values: {
          skills: ['PostgreSQL', 'TypeScript'],
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2022-01'
        },
        extraction: null,
        version: 2,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        claimId: randomUUID(),
        claimType: 'skill',
        origin: 'extracted',
        status: 'rejected',
        values: { name: 'TypeScript' },
        extraction: null,
        version: 2,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ];
    const { createClaims, writer } = dependencies(candidate, reviewedClaims);
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'employment',
        values: {
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2022-01',
          skills: ['TypeScript', 'PostgreSQL', 'TypeScript']
        },
        rawValues: {},
        fieldSources: {},
        current: false
      },
      {
        type: 'skill',
        values: { name: 'TypeScript' },
        rawValues: {},
        fieldSources: {},
        current: false
      },
      {
        type: 'skill',
        values: { name: 'Node.js' },
        rawValues: {},
        fieldSources: { name: ['L12'] },
        current: false
      }
    ];

    await expect(
      writer.saveExtractedClaims(
        userId,
        documentId,
        invocationId,
        drafts,
        transaction
      )
    ).resolves.toHaveLength(1);
    expect(createClaims).toHaveBeenCalledOnce();
    expect(createClaims).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          claimType: 'skill',
          values: { name: 'Node.js' }
        })
      ],
      transaction
    );
  });

  it('writes nothing when the user has no candidate profile', async () => {
    const {
      createClaims,
      deletePendingExtractedClaims,
      listReviewedExtractedClaims,
      writer
    } = dependencies(null);

    await expect(
      writer.saveExtractedClaims(
        userId,
        documentId,
        invocationId,
        [],
        transaction
      )
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(deletePendingExtractedClaims).not.toHaveBeenCalled();
    expect(listReviewedExtractedClaims).not.toHaveBeenCalled();
    expect(createClaims).not.toHaveBeenCalled();
  });
});
