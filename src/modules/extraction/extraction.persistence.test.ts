import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseExecutor,
  UnitOfWork
} from '../../infrastructure/database/unit-of-work.js';
import type { CandidateExtractionWriter } from '../candidates/index.js';
import { ConflictingSourceOccurrenceError } from '../candidates/index.js';
import type { ParsingService } from '../parsing/index.js';
import {
  createExtractionPersistenceCoordinator,
  type ExtractionPersistenceCoordinatorDependencies
} from './extraction.persistence.js';
import type { CandidateExtractionResult } from './extraction.service.js';
import type { ExtractionReviewRepository } from './extraction-review.repository.js';
import {
  InvalidExtractionProvenanceError,
  SourceReferenceResolutionError
} from './extraction.errors.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const ownerUserId = '22222222-2222-4222-8222-222222222222';
const invocationId = '33333333-3333-4333-8333-333333333333';
const transaction = {} as DatabaseExecutor;
const callerTransaction = {} as DatabaseExecutor;
const sourceContent = {
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      regions: [
        {
          index: 0,
          box: { x: 0, y: 0, width: 612, height: 792 },
          confidence: null,
          lines: [
            {
              order: 8,
              text: 'TypeScript',
              box: { x: 40, y: 80, width: 100, height: 12 },
              heading: false,
              bold: false,
              italic: false,
              bullet: false,
              links: []
            }
          ]
        }
      ]
    }
  ],
  blocks: []
};

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
  reviewItems: [
    {
      claimType: 'employment',
      fields: {
        employer: { value: 'Example Corp', confidence: 0.9, sources: ['L12'] }
      },
      issues: [{ field: 'jobTitle', code: 'missing_job_title', required: true }],
      sources: ['L12'],
      fingerprint: 'review-fingerprint'
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
  const replacePendingForDocument = vi
    .fn<ExtractionReviewRepository['replacePendingForDocument']>()
    .mockResolvedValue([]);
  const unitOfWork: UnitOfWork = {
    run: vi.fn(async (work) => work(transaction))
  };

  return {
    saveExtractedClaims,
    saveUnmappedData,
    replacePendingForDocument,
    unitOfWork,
    coordinator: createExtractionPersistenceCoordinator({
      candidateWriter: { saveExtractedClaims },
      reviewRepository: { replacePendingForDocument },
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
      replacePendingForDocument,
      unitOfWork
    } = dependencies();

    await expect(
      coordinator.persist({ documentId, ownerUserId, result, sourceContent })
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
          current: false,
          sourceOccurrences: [
            {
              anchorKey: 'pdf:1:8',
              references: ['L8'],
              fields: ['name'],
              anchor: {
                kind: 'pdf_line',
                order: 8,
                pageNumber: 1,
                box: { x: 40, y: 80, width: 100, height: 12 },
                text: 'TypeScript',
                links: []
              }
            }
          ]
        }
      ],
      transaction
    );
    expect(saveUnmappedData).toHaveBeenCalledWith(
      documentId,
      result.unmapped,
      transaction
    );
    expect(replacePendingForDocument).toHaveBeenCalledWith(
      documentId,
      invocationId,
      result.reviewItems,
      transaction
    );
  });

  it('joins a caller transaction and clears unmapped data with an empty snapshot', async () => {
    const {
      coordinator,
      saveExtractedClaims,
      saveUnmappedData,
      replacePendingForDocument,
      unitOfWork
    } = dependencies();

    await expect(
      coordinator.persist(
        {
          documentId,
          ownerUserId,
          result: { ...result, claims: [], reviewItems: [], unmapped: [] },
          sourceContent
        },
        callerTransaction
      )
    ).resolves.toEqual([]);
    expect(unitOfWork.run).not.toHaveBeenCalled();
    expect(saveExtractedClaims).toHaveBeenCalledWith(
      ownerUserId,
      documentId,
      invocationId,
      [],
      callerTransaction
    );
    expect(saveUnmappedData).toHaveBeenCalledWith(
      documentId,
      [],
      callerTransaction
    );
    expect(replacePendingForDocument).toHaveBeenCalledWith(
      documentId,
      invocationId,
      [],
      callerTransaction
    );
  });

  it('writes nothing when physical claim evidence cannot be resolved', async () => {
    const { coordinator, saveExtractedClaims, saveUnmappedData, replacePendingForDocument } =
      dependencies();

    await expect(
      coordinator.persist(
        {
          documentId,
          ownerUserId,
          result,
          sourceContent: { pages: [], blocks: [] }
        },
        callerTransaction
      )
    ).rejects.toBeInstanceOf(SourceReferenceResolutionError);
    expect(saveExtractedClaims).not.toHaveBeenCalled();
    expect(saveUnmappedData).not.toHaveBeenCalled();
    expect(replacePendingForDocument).not.toHaveBeenCalled();
  });

  it('translates conflicting physical anchors at the extraction boundary', async () => {
    const { coordinator, saveExtractedClaims, saveUnmappedData, replacePendingForDocument } = dependencies();
    const conflict = new ConflictingSourceOccurrenceError('pdf:1:8');
    saveExtractedClaims.mockRejectedValueOnce(conflict);

    const persistence = coordinator.persist(
      { documentId, ownerUserId, result, sourceContent },
      callerTransaction
    );

    await expect(persistence).rejects.toBeInstanceOf(
      InvalidExtractionProvenanceError
    );
    await expect(persistence).rejects.toMatchObject({ cause: conflict });
    expect(saveUnmappedData).not.toHaveBeenCalled();
    expect(replacePendingForDocument).not.toHaveBeenCalled();
  });
});
