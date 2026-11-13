import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseExecutor,
  UnitOfWork
} from '../../infrastructure/database/unit-of-work.js';
import type { CandidateExtractionWriter } from '../candidates/index.js';
import type { ParsingService } from '../parsing/index.js';
import {
  createExtractionPersistenceCoordinator,
  type ExtractionPersistenceCoordinatorDependencies
} from './extraction.persistence.js';
import type { CandidateExtractionResult } from './extraction.service.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const ownerUserId = '22222222-2222-4222-8222-222222222222';
const invocationId = '33333333-3333-4333-8333-333333333333';
const transaction = {} as DatabaseExecutor;
const callerTransaction = {} as DatabaseExecutor;

const result: CandidateExtractionResult = {
  invocationId,
  version: 1,
  profile: { values: {}, rawValues: {}, confidence: {}, sources: {} },
  claims: [
    {
      type: 'skill',
      origin: 'extracted',
      status: 'pending',
      confidence: 0.92,
      fieldConfidence: { name: 0.92 },
      current: false,
      values: { name: 'TypeScript' },
      rawValues: {},
      sources: ['L8'],
      fieldSources: { name: ['L8'] }
    }
  ],
  unmapped: [
    {
      label: 'Awards',
      text: 'Engineering Award',
      sources: ['L12'],
      reason: 'unsupported_section'
    }
  ]
};

function dependencies() {
  const saveExtractedClaims = vi
    .fn<CandidateExtractionWriter['saveExtractedClaims']>()
    .mockResolvedValue([]);
  const saveUnmappedData = vi
    .fn<ParsingService['saveUnmappedData']>()
    .mockResolvedValue(
      {} as Awaited<ReturnType<ParsingService['saveUnmappedData']>>
    );
  const unitOfWork: UnitOfWork = {
    run: vi.fn(async (work) => work(transaction))
  };

  return {
    saveExtractedClaims,
    saveUnmappedData,
    unitOfWork,
    coordinator: createExtractionPersistenceCoordinator({
      candidateWriter: { saveExtractedClaims },
      parsingService: { saveUnmappedData },
      unitOfWork
    } satisfies ExtractionPersistenceCoordinatorDependencies)
  };
}

describe('extraction persistence coordinator', () => {
  it('owns a transaction for standalone persistence', async () => {
    const {
      coordinator,
      saveExtractedClaims,
      saveUnmappedData,
      unitOfWork
    } = dependencies();

    await expect(
      coordinator.persist({ documentId, ownerUserId, result })
    ).resolves.toEqual([]);
    expect(unitOfWork.run).toHaveBeenCalledOnce();
    expect(saveExtractedClaims).toHaveBeenCalledWith(
      ownerUserId,
      documentId,
      invocationId,
      [
        {
          type: 'skill',
          values: { name: 'TypeScript' },
          rawValues: {},
          fieldSources: { name: ['L8'] },
          current: false
        }
      ],
      transaction
    );
    expect(saveUnmappedData).toHaveBeenCalledWith(
      documentId,
      result.unmapped,
      transaction
    );
  });

  it('joins a caller transaction without starting another', async () => {
    const {
      coordinator,
      saveExtractedClaims,
      saveUnmappedData,
      unitOfWork
    } = dependencies();

    await expect(
      coordinator.persist(
        { documentId, ownerUserId, result },
        callerTransaction
      )
    ).resolves.toEqual([]);
    expect(unitOfWork.run).not.toHaveBeenCalled();
    expect(saveExtractedClaims).toHaveBeenCalledWith(
      ownerUserId,
      documentId,
      invocationId,
      expect.any(Array),
      callerTransaction
    );
    expect(saveUnmappedData).toHaveBeenCalledWith(
      documentId,
      result.unmapped,
      callerTransaction
    );
  });
});
