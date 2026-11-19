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
  reviewedClaims: ClaimRecord[] = [],
  activeClaims: ClaimRecord[] = [],
  termLookup?: CandidateExtractionWriterDependencies['termLookup']
) {
  const findCandidateByUserId = vi.fn().mockResolvedValue(foundCandidate);
  const deletePendingExtractedClaims = vi.fn().mockResolvedValue(0);
  const listReviewedExtractedClaims = vi
    .fn()
    .mockResolvedValue(reviewedClaims);
  const listClaims = vi.fn().mockResolvedValue(activeClaims);
  const createClaims = vi
    .fn<CandidateExtractionWriterDependencies['repository']['createClaims']>()
    .mockImplementation(async (inputs) =>
      inputs.map((input) => ({
        claimId: randomUUID(),
        supersededByClaimId: null,
        claimType: input.claimType,
        origin: input.origin,
        status: input.status,
        current: input.origin === 'extracted' ? input.extraction.current : false,
        candidateEdited: false,
        values: input.values,
        extraction: input.origin === 'extracted' ? input.extraction : null,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      }))
    );
  const createClaim = vi
    .fn<CandidateExtractionWriterDependencies['repository']['createClaim']>()
    .mockImplementation(async (input) => ({
      claimId: randomUUID(),
      supersededByClaimId: null,
      claimType: input.claimType,
      origin: input.origin,
      status: input.status,
      current: input.origin === 'extracted' ? input.extraction.current : false,
      candidateEdited: false,
      values: input.values,
      extraction: input.origin === 'extracted' ? input.extraction : null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
  const createClaimSourceOccurrences = vi
    .fn<
      CandidateExtractionWriterDependencies['repository']['createClaimSourceOccurrences']
    >()
    .mockImplementation(async (inputs) => inputs.length);
  const repository = {
    findCandidateByUserId,
    deletePendingExtractedClaims,
    listReviewedExtractedClaims,
    listClaims,
    createClaim,
    createClaims,
    createClaimSourceOccurrences
  } as CandidateExtractionWriterDependencies['repository'];

  return {
    findCandidateByUserId,
    deletePendingExtractedClaims,
    listReviewedExtractedClaims,
    listClaims,
    createClaim,
    createClaims,
    createClaimSourceOccurrences,
    writer: createCandidateExtractionWriter({
      repository,
      ...(termLookup ? { termLookup } : {})
    })
  };
}

function savedClaim(
  claimType: ClaimRecord['claimType'],
  values: ClaimRecord['values'],
  overrides: Partial<ClaimRecord> = {}
): ClaimRecord {
  return {
    claimId: randomUUID(),
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

function skillDraft(name: string, anchorKey = `anchor-${name}`): ExtractedClaimDraftInput {
  return {
    type: 'skill',
    status: 'accepted',
    values: { name },
    rawValues: {},
    fieldSources: { name: ['L20'] },
    current: false,
    sourceOccurrences: [
      {
        anchorKey,
        references: ['L20'],
        fields: ['name'],
        anchor: { page: 1, lineIds: ['L20'] } as unknown as ExtractedClaimDraftInput['sourceOccurrences'][number]['anchor']
      }
    ]
  };
}

describe('drafts that repeat an existing claim', () => {
  it('adds the new document as a source of the same claim instead of a duplicate', async () => {
    const python = savedClaim('skill', { name: 'Python' });
    const { createClaims, createClaimSourceOccurrences, writer } = dependencies(
      candidate,
      [],
      [python]
    );

    const created = await writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      [skillDraft('Python'), skillDraft('Kotlin')],
      transaction
    );

    expect(created.map((claim) => claim.values)).toEqual([{ name: 'Kotlin' }]);
    expect(createClaims).toHaveBeenCalledWith(
      [expect.objectContaining({ values: { name: 'Kotlin' } })],
      transaction
    );
    expect(createClaimSourceOccurrences).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          claimId: python.claimId,
          documentId,
          anchorKey: 'anchor-Python'
        })
      ]),
      transaction
    );
  });

  it('treats spellings of one canonical term as the same claim', async () => {
    const postgresql = savedClaim('skill', { name: 'PostgreSQL' });
    const termLookup = {
      findDictionaryTerms: vi.fn().mockResolvedValue([{ name: 't-pg' }]),
      findNormalizedTerms: vi
        .fn()
        .mockResolvedValue(new Map([[postgresql.claimId, { name: 't-pg' }]]))
    };
    const withTerms = dependencies(candidate, [], [postgresql], termLookup);
    const withoutTerms = dependencies(candidate, [], [postgresql]);

    await withTerms.writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      [skillDraft('Postgres')],
      transaction
    );
    await withoutTerms.writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      [skillDraft('Postgres')],
      transaction
    );

    expect(termLookup.findDictionaryTerms).toHaveBeenCalledWith([
      { claimType: 'skill', values: { name: 'Postgres' } }
    ]);
    expect(withTerms.createClaims).toHaveBeenCalledWith([], transaction);
    expect(withTerms.createClaimSourceOccurrences).toHaveBeenCalledWith(
      [expect.objectContaining({ claimId: postgresql.claimId })],
      transaction
    );
    expect(withoutTerms.createClaims).toHaveBeenCalledWith(
      [expect.objectContaining({ values: { name: 'Postgres' } })],
      transaction
    );
  });

  it('saves a draft that adds a value as its own claim', async () => {
    const job = savedClaim('employment', {
      employer: 'Northstar Labs',
      jobTitle: 'Backend Engineer',
      startDate: '2022-01'
    });
    const { createClaims, writer } = dependencies(candidate, [], [job]);

    await writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      [
        {
          type: 'employment',
          status: 'accepted',
          values: { ...job.values, location: 'Austin, TX' },
          rawValues: {},
          fieldSources: {},
          current: false,
          sourceOccurrences: []
        }
      ],
      transaction
    );

    expect(createClaims).toHaveBeenCalledWith(
      [expect.objectContaining({ values: expect.objectContaining({ location: 'Austin, TX' }) })],
      transaction
    );
  });

  it('compares values as written when the dictionary cannot be read', async () => {
    const termLookup = {
      findDictionaryTerms: vi.fn().mockRejectedValue(new Error('offline')),
      findNormalizedTerms: vi.fn().mockResolvedValue(new Map())
    };
    const { createClaims, writer } = dependencies(
      candidate,
      [],
      [savedClaim('skill', { name: 'PostgreSQL' })],
      termLookup
    );

    await expect(
      writer.saveExtractedClaims(
        userId,
        documentId,
        invocationId,
        [skillDraft('Postgres')],
        transaction
      )
    ).resolves.toHaveLength(1);
    expect(createClaims).toHaveBeenCalledWith(
      [expect.objectContaining({ values: { name: 'Postgres' } })],
      transaction
    );
  });

  it('does not add sources to rejected or merged claims', async () => {
    const { createClaims, writer } = dependencies(candidate, [], [
      savedClaim('skill', { name: 'Python' }, { status: 'rejected' }),
      savedClaim('skill', { name: 'Python' }, { supersededByClaimId: randomUUID() })
    ]);

    await writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      [skillDraft('Python')],
      transaction
    );

    expect(createClaims).toHaveBeenCalledWith(
      [expect.objectContaining({ values: { name: 'Python' } })],
      transaction
    );
  });
});

describe('candidate extraction writer', () => {
  it('replaces same-document pending claims before saving new drafts', async () => {
    const {
      createClaims,
      createClaimSourceOccurrences,
      deletePendingExtractedClaims,
      findCandidateByUserId,
      listReviewedExtractedClaims,
      writer
    } = dependencies(candidate);
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'skill',
        status: 'accepted',
        values: { name: 'TypeScript' },
        rawValues: {},
        fieldSources: { name: ['L9'] },
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:9',
            references: ['L9'],
            fields: ['name'],
            anchor: {
              kind: 'pdf_line',
              order: 9,
              pageNumber: 1,
              box: { x: 10, y: 20, width: 100, height: 12 },
              text: 'TypeScript',
              links: []
            }
          }
        ]
      },
      {
        type: 'employment',
        status: 'pending',
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
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:5',
            references: ['L5'],
            fields: ['employer'],
            anchor: {
              kind: 'pdf_line',
              order: 5,
              pageNumber: 1,
              box: { x: 10, y: 50, width: 180, height: 12 },
              text: 'Example Labs — Backend Engineer',
              links: []
            }
          }
        ]
      },
      {
        type: 'employment',
        status: 'accepted',
        values: {
          employer: '  EXAMPLE   LABS ',
          jobTitle: 'backend engineer',
          startDate: '2022-01'
        },
        rawValues: { startDate: 'Jan 2022' },
        fieldSources: {
          employer: ['L5-6'],
          jobTitle: ['L5-6'],
          startDate: ['L6']
        },
        current: true,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:5',
            references: ['L5-6'],
            fields: ['jobTitle'],
            anchor: {
              kind: 'pdf_line',
              order: 5,
              pageNumber: 1,
              box: { x: 10, y: 50, width: 180, height: 12 },
              text: 'Example Labs — Backend Engineer',
              links: []
            }
          },
          {
            anchorKey: 'pdf:1:6',
            references: ['L6'],
            fields: ['startDate'],
            anchor: {
              kind: 'pdf_line',
              order: 6,
              pageNumber: 1,
              box: { x: 10, y: 65, width: 80, height: 12 },
              text: 'January 2022',
              links: []
            }
          }
        ]
      }
    ];

    const saved = await writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      drafts,
      transaction
    );
    expect(saved).toHaveLength(2);
    expect(findCandidateByUserId).toHaveBeenCalledWith(userId, transaction);
    expect(deletePendingExtractedClaims).toHaveBeenCalledWith(
      candidateId,
      documentId,
      transaction
    );
    expect(createClaimSourceOccurrences).toHaveBeenCalledWith(
      [
        {
          claimId: saved[0]!.claimId,
          documentId,
          anchorKey: 'pdf:1:9',
          sourceReferences: ['L9'],
          fieldNames: ['name'],
          anchor: drafts[0]!.sourceOccurrences[0]!.anchor
        },
        {
          claimId: saved[1]!.claimId,
          documentId,
          anchorKey: 'pdf:1:5',
          sourceReferences: ['L5', 'L5-6'],
          fieldNames: ['employer', 'jobTitle'],
          anchor: drafts[1]!.sourceOccurrences[0]!.anchor
        },
        {
          claimId: saved[1]!.claimId,
          documentId,
          anchorKey: 'pdf:1:6',
          sourceReferences: ['L6'],
          fieldNames: ['startDate'],
          anchor: drafts[2]!.sourceOccurrences[1]!.anchor
        }
      ],
      transaction
    );
    expect(
      createClaims.mock.invocationCallOrder[0]
    ).toBeLessThan(createClaimSourceOccurrences.mock.invocationCallOrder[0]!);
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
          status: 'accepted',
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
            fieldSources: {
              employer: ['L5', 'L5-6'],
              jobTitle: ['L5', 'L5-6'],
              startDate: ['L6']
            },
            current: true
          }
        }
      ],
      transaction
    );
  });

  it('skips formatting-equivalent reviewed claims and saves meaningful differences', async () => {
    const reviewedClaims: ClaimRecord[] = [
      {
        claimId: randomUUID(),
        supersededByClaimId: null,
        claimType: 'employment',
        origin: 'extracted',
        status: 'accepted',
        current: false,
        candidateEdited: false,
        values: {
          skills: [' postgresql ', 'TYPESCRIPT'],
          employer: '  EXAMPLE   LABS ',
          jobTitle: 'Ｂａｃｋｅｎｄ Engineer',
          startDate: '2022-01'
        },
        extraction: null,
        version: 2,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        claimId: randomUUID(),
        supersededByClaimId: null,
        claimType: 'skill',
        origin: 'extracted',
        status: 'rejected',
        current: false,
        candidateEdited: false,
        values: { name: 'ＴｙｐｅＳｃｒｉｐｔ' },
        extraction: null,
        version: 2,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        claimId: randomUUID(),
        supersededByClaimId: null,
        claimType: 'skill',
        origin: 'extracted',
        status: 'accepted',
        current: false,
        candidateEdited: false,
        values: { name: 'NodeJS' },
        extraction: null,
        version: 2,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ];
    const { createClaims, createClaimSourceOccurrences, writer } =
      dependencies(candidate, reviewedClaims);
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'employment',
        status: 'accepted',
        values: {
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2022-01',
          skills: ['TypeScript', 'PostgreSQL', 'TypeScript']
        },
        rawValues: {},
        fieldSources: {},
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:5',
            references: ['L5'],
            fields: ['employer'],
            anchor: {
              kind: 'pdf_line',
              order: 5,
              pageNumber: 1,
              box: { x: 10, y: 20, width: 100, height: 12 },
              text: 'Example Labs',
              links: []
            }
          }
        ]
      },
      {
        type: 'skill',
        status: 'accepted',
        values: { name: 'typescript' },
        rawValues: {},
        fieldSources: {},
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:9',
            references: ['L9'],
            fields: ['name'],
            anchor: {
              kind: 'pdf_line',
              order: 9,
              pageNumber: 1,
              box: { x: 10, y: 40, width: 100, height: 12 },
              text: 'TypeScript',
              links: []
            }
          }
        ]
      },
      {
        type: 'employment',
        status: 'pending',
        values: {
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2022-01',
          skills: ['TypeScript', 'PostgreSQL', 'Docker']
        },
        rawValues: {},
        fieldSources: {},
        current: false,
        sourceOccurrences: []
      },
      {
        type: 'skill',
        status: 'pending',
        values: { name: 'Node.js' },
        rawValues: {},
        fieldSources: { name: ['L12'] },
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:12',
            references: ['L12'],
            fields: ['name'],
            anchor: {
              kind: 'pdf_line',
              order: 12,
              pageNumber: 1,
              box: { x: 10, y: 60, width: 100, height: 12 },
              text: 'Node.js',
              links: []
            }
          }
        ]
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
    expect(createClaims).toHaveBeenCalledOnce();
    expect(createClaims).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          claimType: 'employment',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Backend Engineer',
            startDate: '2022-01',
            skills: ['TypeScript', 'PostgreSQL', 'Docker']
          }
        }),
        expect.objectContaining({
          claimType: 'skill',
          values: { name: 'Node.js' }
        })
      ],
      transaction
    );
    expect(createClaimSourceOccurrences).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          documentId,
          anchorKey: 'pdf:1:12',
          sourceReferences: ['L12'],
          fieldNames: ['name']
        })
      ],
      transaction
    );
  });

  it('keeps an otherwise accepted draft pending when it conflicts with an active claim', async () => {
    const activeClaim: ClaimRecord = {
      claimId: randomUUID(),
      supersededByClaimId: null,
      claimType: 'language',
      origin: 'manual',
      status: 'accepted',
      current: false,
      candidateEdited: true,
      values: { name: 'English', proficiency: 'Native' },
      extraction: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const { createClaims, listClaims, writer } = dependencies(
      candidate,
      [],
      [activeClaim]
    );
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'language',
        status: 'accepted',
        values: { name: 'English', proficiency: 'C1' },
        rawValues: {},
        fieldSources: { name: ['L8'], proficiency: ['L8'] },
        current: false,
        sourceOccurrences: []
      }
    ];

    await writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      drafts,
      transaction
    );

    expect(listClaims).toHaveBeenCalledWith(candidateId, {}, transaction);
    expect(createClaims).toHaveBeenCalledWith(
      [expect.objectContaining({ status: 'pending' })],
      transaction
    );
  });

  it('keeps conflicting accepted drafts from the same extraction pending', async () => {
    const { createClaims, writer } = dependencies(candidate);
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'language',
        status: 'accepted',
        values: { name: 'English', proficiency: 'Native' },
        rawValues: {},
        fieldSources: {},
        current: false,
        sourceOccurrences: []
      },
      {
        type: 'language',
        status: 'accepted',
        values: { name: 'English', proficiency: 'C1' },
        rawValues: {},
        fieldSources: {},
        current: false,
        sourceOccurrences: []
      }
    ];

    await writer.saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      drafts,
      transaction
    );

    expect(createClaims).toHaveBeenCalledWith(
      [
        expect.objectContaining({ status: 'pending' }),
        expect.objectContaining({ status: 'pending' })
      ],
      transaction
    );
  });

  it('rejects conflicting physical anchors across non-equivalent drafts before writing', async () => {
    const {
      createClaims,
      createClaimSourceOccurrences,
      deletePendingExtractedClaims,
      listReviewedExtractedClaims,
      writer
    } = dependencies(candidate);
    const drafts: ExtractedClaimDraftInput[] = [
      {
        type: 'skill',
        status: 'accepted',
        values: { name: 'TypeScript' },
        rawValues: {},
        fieldSources: { name: ['L9'] },
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:9',
            references: ['L9'],
            fields: ['name'],
            anchor: {
              kind: 'pdf_line',
              order: 9,
              pageNumber: 1,
              box: { x: 10, y: 20, width: 100, height: 12 },
              text: 'TypeScript',
              links: []
            }
          }
        ]
      },
      {
        type: 'skill',
        status: 'accepted',
        values: { name: 'JavaScript' },
        rawValues: {},
        fieldSources: { name: ['L9'] },
        current: false,
        sourceOccurrences: [
          {
            anchorKey: 'pdf:1:9',
            references: ['L9'],
            fields: ['name'],
            anchor: {
              kind: 'pdf_line',
              order: 9,
              pageNumber: 1,
              box: { x: 10, y: 20, width: 100, height: 12 },
              text: 'JavaScript',
              links: []
            }
          }
        ]
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
    ).rejects.toThrow(
      "Source occurrence 'pdf:1:9' has conflicting physical anchors"
    );
    expect(deletePendingExtractedClaims).not.toHaveBeenCalled();
    expect(listReviewedExtractedClaims).not.toHaveBeenCalled();
    expect(createClaims).not.toHaveBeenCalled();
    expect(createClaimSourceOccurrences).not.toHaveBeenCalled();
  });

  it('writes nothing when the user has no candidate profile', async () => {
    const {
      createClaims,
      createClaimSourceOccurrences,
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
    expect(createClaimSourceOccurrences).not.toHaveBeenCalled();
  });

  it('creates a corrected review item as an accepted extracted claim', async () => {
    const { createClaim, writer } = dependencies(candidate);

    await expect(
      writer.saveResolvedClaim(
        userId,
        {
          type: 'employment',
          values: {
            employer: ' Example Corp ',
            jobTitle: ' Engineer ',
            startDate: '2024'
          },
          documentId,
          invocationId,
          rawValues: { startDate: '2024' },
          fieldSources: { employer: ['L1'], startDate: ['L2'] },
          current: false
        },
        transaction
      )
    ).resolves.toMatchObject({ status: 'accepted', origin: 'extracted' });
    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId,
        claimType: 'employment',
        status: 'accepted',
        values: {
          employer: 'Example Corp',
          jobTitle: 'Engineer',
          startDate: '2024'
        }
      }),
      transaction
    );
  });

  it('does not create a claim when corrected values are invalid', async () => {
    const { createClaim, writer } = dependencies(candidate);

    await expect(
      writer.saveResolvedClaim(
        userId,
        {
          type: 'employment',
          values: { employer: 'Example Corp' },
          documentId,
          invocationId,
          rawValues: {},
          fieldSources: {},
          current: false
        },
        transaction
      )
    ).rejects.toMatchObject({ code: 'INVALID_CLAIM_VALUES' });
    expect(createClaim).not.toHaveBeenCalled();
  });
});
