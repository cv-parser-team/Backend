import { getTableConfig } from 'drizzle-orm/pg-core';
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ForeignKeyViolationError,
  UniqueConstraintViolationError
} from '../../infrastructure/database/database.errors.js';
import { errorHandlerPlugin } from '../../infrastructure/http/error-handler.plugin.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { createAuthGuards } from '../auth/auth.guards.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { JwtService, UserRole } from '../auth/jwt-service.js';
import { UsersService } from '../users/users.service.js';
import {
  CandidateProfileExistsError,
  ClaimNotReviewableError,
  ClaimTypeMismatchError,
  InvalidClaimDatesError,
  OverlappingBatchClaimsError,
  VersionConflictError
} from './candidates.errors.js';
import {
  CandidateRecord,
  CandidatesRepository,
  ClaimRecord
} from './candidates.repository.js';
import { candidatesRoutes } from './candidates.routes.js';
import {
  CandidateProfile,
  CandidatesService,
  ClaimNormalizer,
  createCandidatesService
} from './candidates.service.js';
import type { DuplicateJudge } from './candidates.duplicate-ai.js';
import {
  candidates,
  certificationDetails,
  claimOrigin,
  claimRevisions,
  claims,
  claimStatus,
  claimType,
  educationDetails,
  employmentDetails,
  languageDetails,
  projectDetails,
  sourceOccurrences,
  skillDetails
} from './candidates.table.js';

const userId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const claimId = '33333333-3333-4333-8333-333333333333';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

const candidateRecord: CandidateRecord = {
  candidateId,
  userId,
  fullName: 'Example Candidate',
  headline: 'Backend Developer',
  summary: null,
  phone: null,
  location: 'Amman',
  contactEmail: null,
  profileLinks: [],
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp
};

function claimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimId,
    supersededByClaimId: null,
    claimType: 'skill',
    origin: 'manual',
    status: 'accepted',
    current: false,
    candidateEdited: false,
    values: { name: 'Python' },
    extraction: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function extractedClaim(
  status: ClaimRecord['status'] = 'pending',
  version = 1
): ClaimRecord {
  return claimRecord({
    origin: 'extracted',
    status,
    extraction: {
      invocationId: '44444444-4444-4444-8444-444444444444',
      sourceDocumentId: '55555555-5555-4555-8555-555555555555',
      rawValues: {},
      fieldSources: { name: ['L8'] },
      current: false
    },
    version
  });
}

function createRepositoryDouble(
  candidate: CandidateRecord | null = candidateRecord
): CandidatesRepository {
  return {
    findCandidateByUserId: vi.fn().mockResolvedValue(candidate),
    createCandidate: vi.fn().mockResolvedValue(candidateRecord),
    updateCandidate: vi
      .fn()
      .mockResolvedValue({ status: 'saved', record: candidateRecord }),
    createClaim: vi.fn().mockResolvedValue(claimRecord()),
    createClaims: vi.fn().mockResolvedValue([]),
    createClaimSourceOccurrences: vi.fn().mockResolvedValue(0),
    transferClaimSourceOccurrences: vi.fn().mockResolvedValue({
      moved: 0,
      skipped: 0
    }),
    coalescePendingClaims: vi.fn().mockResolvedValue({ status: 'missing' }),
    mergeConfirmedClaims: vi.fn().mockResolvedValue({ status: 'missing' }),
    mergeConfirmedClaimGroup: vi.fn().mockResolvedValue({ status: 'missing' }),
    recordClaimsDifferent: vi.fn().mockResolvedValue({ status: 'missing' }),
    listClaimPairDecisions: vi.fn().mockResolvedValue([]),
    deletePendingExtractedClaims: vi.fn().mockResolvedValue(0),
    deleteUnreviewedExtractedClaims: vi.fn().mockResolvedValue(0),
    listReviewedExtractedClaims: vi.fn().mockResolvedValue([]),
    reviewExtractedClaim: vi
      .fn()
      .mockResolvedValue({ status: 'saved', record: extractedClaim('accepted', 2) }),
    listClaims: vi.fn().mockResolvedValue([]),
    listClaimSourceOccurrences: vi.fn().mockResolvedValue([]),
    findClaim: vi.fn().mockResolvedValue(claimRecord()),
    updateClaimValues: vi
      .fn()
      .mockResolvedValue({ status: 'saved', record: claimRecord() }),
    deleteClaim: vi.fn().mockResolvedValue({ status: 'deleted' }),
    autoAcceptMergeClaims: vi.fn().mockResolvedValue({ status: 'missing' }),
    acknowledgeAutoMergeNotices: vi.fn().mockResolvedValue(0),
    keepAutoMergedClaimsSeparate: vi.fn().mockResolvedValue({ status: 'missing' }),
    countOpenAutoMergeNotices: vi.fn().mockResolvedValue(0),
    listOpenAutoMergeNotices: vi.fn().mockResolvedValue([]),
    setClaimStatus: vi.fn().mockResolvedValue(null)
  };
}

function createUsersServiceDouble(): Pick<UsersService, 'getUserById'> {
  return {
    getUserById: vi.fn().mockResolvedValue({
      userId,
      name: 'Example Candidate',
      email: 'candidate@example.com',
      role: 'candidate',
      accountStatus: 'active',
      emailVerifiedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  };
}

function createNormalizerDouble(): ClaimNormalizer {
  return {
    normalizeClaim: vi.fn().mockResolvedValue(null),
    findNormalizedTerms: vi.fn().mockResolvedValue(new Map()),
    describeNormalizedValues: vi.fn().mockResolvedValue(new Map())
  };
}

function createService(
  repository: CandidatesRepository,
  normalizer: ClaimNormalizer = createNormalizerDouble(),
  logger = { warn: vi.fn() },
  duplicateJudge?: DuplicateJudge
): CandidatesService {
  return createCandidatesService({
    repository,
    usersService: createUsersServiceDouble(),
    normalizer,
    logger,
    ...(duplicateJudge ? { duplicateJudge } : {})
  });
}

describe('candidates tables', () => {
  it('defines the claim enumerations', () => {
    expect(claimType.enumValues).toEqual([
      'skill',
      'employment',
      'education',
      'certification',
      'language',
      'project'
    ]);
    expect(claimOrigin.enumValues).toEqual(['manual', 'extracted']);
    expect(claimStatus.enumValues).toEqual(['pending', 'accepted', 'auto_accepted', 'rejected']);
  });

  it('versions profiles and claims, starting at 1', () => {
    for (const column of [candidates.version, claims.version]) {
      expect(column.notNull).toBe(true);
      expect(column.default).toBe(1);
    }
  });

  it('keeps complete extraction evidence only on extracted claims', () => {
    const config = getTableConfig(claims);
    const evidenceColumns = [
      claims.extractionInvocationId,
      claims.extractionDocumentId,
      claims.extractionRawValues,
      claims.extractionFieldSources,
      claims.extractionCurrent
    ];

    expect(evidenceColumns.every((column) => !column.notNull)).toBe(true);
    expect(
      config.checks.some(
        (constraint) => constraint.name === 'claims_extraction_metadata_matches_origin'
      )
    ).toBe(true);
  });

  it('links profiles to users and claims to their owners', () => {
    expect(getTableConfig(candidates).foreignKeys).toHaveLength(1);
    expect(getTableConfig(claims).foreignKeys).toHaveLength(2);
    expect(getTableConfig(claimRevisions).foreignKeys).toHaveLength(1);
    expect(getTableConfig(sourceOccurrences).foreignKeys).toHaveLength(2);
    expect(
      getTableConfig(sourceOccurrences).indexes.some(
        (index) =>
          index.config.name ===
          'source_occurrences_claim_document_anchor_unique'
      )
    ).toBe(true);
  });

  it('deletes merged duplicates with the survivor that absorbed them', () => {
    const supersededBy = getTableConfig(claims).foreignKeys.find((foreignKey) =>
      foreignKey
        .reference()
        .columns.some((column) => column.name === 'superseded_by_claim_id')
    );
    expect(supersededBy?.onDelete).toBe('cascade');
  });

  it('stores one details row per claim in the table of its type', () => {
    for (const table of [
      skillDetails,
      employmentDetails,
      educationDetails,
      certificationDetails,
      languageDetails,
      projectDetails
    ]) {
      const config = getTableConfig(table);
      const claimIdColumn = config.columns.find((column) => column.name === 'claim_id');

      expect(claimIdColumn?.primary).toBe(true);
      expect(config.foreignKeys).toHaveLength(1);
    }
  });

  it('enforces date order in the database', () => {
    expect(getTableConfig(employmentDetails).checks).toHaveLength(2);
    expect(getTableConfig(educationDetails).checks).toHaveLength(2);
    expect(getTableConfig(certificationDetails).checks).toHaveLength(2);
    expect(getTableConfig(projectDetails).checks).toHaveLength(3);
  });

  it('indexes employment and project skills for search', () => {
    for (const [table, name] of [
      [employmentDetails, 'employment_details_skills_idx'],
      [projectDetails, 'project_details_skills_idx']
    ] as const) {
      const skillsIndex = getTableConfig(table).indexes.find(
        (index) => index.config.name === name
      );

      expect(skillsIndex?.config.method).toBe('gin');
    }
  });
});

describe('candidates service', () => {
  it('creates a normalized profile for the authenticated user', async () => {
    const repository = createRepositoryDouble(null);
    const service = createService(repository);

    const result = await service.createProfile(userId, {
      fullName: '  Example Candidate  ',
      location: ' Amman ',
      contactEmail: ' hello@example.com ',
      profileLinks: [{ label: ' GitHub ', url: 'https://github.com/example' }]
    });

    expect(repository.createCandidate).toHaveBeenCalledWith({
      userId,
      fullName: 'Example Candidate',
      headline: null,
      summary: null,
      phone: null,
      location: 'Amman',
      contactEmail: 'hello@example.com',
      profileLinks: [{ label: 'GitHub', url: 'https://github.com/example' }]
    });
    expect(result.email).toBe('candidate@example.com');
  });

  it('rejects a second profile for the same user', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await expect(
      service.createProfile(userId, { fullName: 'Example Candidate' })
    ).rejects.toBeInstanceOf(CandidateProfileExistsError);
    expect(repository.createCandidate).not.toHaveBeenCalled();
  });

  it('rejects a profile created at the same moment by another request', async () => {
    const repository = createRepositoryDouble(null);
    vi.mocked(repository.createCandidate).mockRejectedValue(
      new UniqueConstraintViolationError('Candidate already exists')
    );
    const service = createService(repository);

    await expect(
      service.createProfile(userId, { fullName: 'Example Candidate' })
    ).rejects.toBeInstanceOf(CandidateProfileExistsError);
  });

  it('passes other profile creation errors on unchanged', async () => {
    const failure = new ForeignKeyViolationError('Candidate references a missing user');
    const repository = createRepositoryDouble(null);
    vi.mocked(repository.createCandidate).mockRejectedValue(failure);
    const service = createService(repository);

    await expect(
      service.createProfile(userId, { fullName: 'Example Candidate' })
    ).rejects.toBe(failure);
  });

  it('requires a profile before managing claims', async () => {
    const service = createService(createRepositoryDouble(null));

    await expect(service.getProfile(userId)).rejects.toBeInstanceOf(
      RecordNotFoundError
    );
    await expect(
      service.createClaim(userId, { type: 'skill', values: { name: 'Python' } })
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('reads a claim through the candidate ownership scope', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await expect(service.getClaim(userId, claimId)).resolves.toEqual(
      claimRecord()
    );
    expect(repository.findClaim).toHaveBeenCalledWith(candidateId, claimId);
  });

  it('clears optional profile fields set to null', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await service.updateProfile(userId, {
      headline: null,
      summary: ' APIs ',
      contactEmail: null
    });

    expect(repository.updateCandidate).toHaveBeenCalledWith(
      candidateId,
      { headline: null, summary: 'APIs', contactEmail: null },
      undefined
    );
  });

  it('stores manual claims as accepted with normalized values', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await service.createClaim(userId, {
      type: 'employment',
      values: {
        employer: ' Aramex ',
        jobTitle: 'Backend Developer',
        startDate: '2021-03',
        skills: ['Node.js', ' Node.js ', 'PostgreSQL']
      }
    });

    expect(repository.createClaim).toHaveBeenCalledWith({
      candidateId,
      claimType: 'employment',
      origin: 'manual',
      status: 'accepted',
      values: {
        employer: 'Aramex',
        jobTitle: 'Backend Developer',
        startDate: '2021-03',
        skills: ['Node.js', 'PostgreSQL']
      }
    });
  });

  it('stores languages with their proficiency as written', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await service.createClaim(userId, {
      type: 'language',
      values: { name: ' English ', proficiency: ' Very good ' }
    });

    expect(repository.createClaim).toHaveBeenCalledWith({
      candidateId,
      claimType: 'language',
      origin: 'manual',
      status: 'accepted',
      values: { name: 'English', proficiency: 'Very good' }
    });
  });

  it('stores projects without requiring dates', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await service.createClaim(userId, {
      type: 'project',
      values: {
        name: ' Shop API ',
        url: 'https://github.com/example/shop',
        skills: ['Laravel', ' Laravel ', 'Docker']
      }
    });

    expect(repository.createClaim).toHaveBeenCalledWith({
      candidateId,
      claimType: 'project',
      origin: 'manual',
      status: 'accepted',
      values: {
        name: 'Shop API',
        url: 'https://github.com/example/shop',
        skills: ['Laravel', 'Docker']
      }
    });
  });

  it('normalizes a claim after saving it', async () => {
    const repository = createRepositoryDouble();
    const normalizer = createNormalizerDouble();
    const service = createService(repository, normalizer);

    const claim = await service.createClaim(userId, { type: 'skill', values: { name: 'JS' } });

    expect(normalizer.normalizeClaim).toHaveBeenCalledWith(claim);
  });

  it('keeps a saved claim when normalization fails', async () => {
    const repository = createRepositoryDouble();
    const normalizer = createNormalizerDouble();
    vi.mocked(normalizer.normalizeClaim).mockRejectedValue(new Error('dictionary unavailable'));
    const logger = { warn: vi.fn() };
    const service = createService(repository, normalizer, logger);

    await expect(
      service.createClaim(userId, { type: 'skill', values: { name: 'JS' } })
    ).resolves.toEqual(claimRecord());
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('normalizes a changed claim again but not an unchanged one', async () => {
    const repository = createRepositoryDouble();
    const normalizer = createNormalizerDouble();
    const service = createService(repository, normalizer);

    await service.updateClaim(userId, claimId, { type: 'skill', values: { name: 'Python' } });
    expect(normalizer.normalizeClaim).not.toHaveBeenCalled();

    await service.updateClaim(userId, claimId, { type: 'skill', values: { name: 'Python 3' } });
    expect(normalizer.normalizeClaim).toHaveBeenCalledOnce();
  });

  it('rejects end dates before start dates', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await expect(
      service.createClaim(userId, {
        type: 'education',
        values: {
          institution: 'University of Jordan',
          degree: 'BSc',
          startDate: '2020-09',
          endDate: '2019-06'
        }
      })
    ).rejects.toBeInstanceOf(InvalidClaimDatesError);
    await expect(
      service.createClaim(userId, {
        type: 'certification',
        values: {
          title: 'AWS Certified Developer',
          issuer: 'Amazon',
          issueDate: '2023-01',
          expiryDate: '2022-01'
        }
      })
    ).rejects.toBeInstanceOf(InvalidClaimDatesError);
    await expect(
      service.createClaim(userId, {
        type: 'project',
        values: { name: 'Shop API', startDate: '2024-06', endDate: '2024-03' }
      })
    ).rejects.toBeInstanceOf(InvalidClaimDatesError);
    expect(repository.createClaim).not.toHaveBeenCalled();
  });

  it('accepts year-only dates and compares their full possible range', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await service.createClaim(userId, {
      type: 'employment',
      values: {
        employer: 'Example Corp',
        jobTitle: 'Developer',
        startDate: '2021-06',
        endDate: '2021'
      }
    });

    expect(repository.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ startDate: '2021-06', endDate: '2021' })
      })
    );
  });

  it('sends the complete new values when a claim changes', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.findClaim).mockResolvedValue(
      claimRecord({
        claimType: 'employment',
        values: {
          employer: 'Aramex',
          jobTitle: 'Developer',
          startDate: '2021-03',
          endDate: '2023-06'
        }
      })
    );
    const service = createService(repository);

    await service.updateClaim(userId, claimId, {
      type: 'employment',
      values: {
        employer: 'Aramex',
        jobTitle: 'Backend Developer',
        startDate: '2021-03'
      }
    });

    expect(repository.updateClaimValues).toHaveBeenCalledWith({
      candidateId,
      claimId,
      values: {
        employer: 'Aramex',
        jobTitle: 'Backend Developer',
        startDate: '2021-03'
      }
    });
  });

  it('does not write unchanged claims', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    const result = await service.updateClaim(userId, claimId, {
      type: 'skill',
      values: { name: ' Python ' }
    });

    expect(repository.updateClaimValues).not.toHaveBeenCalled();
    expect(result.values).toEqual({ name: 'Python' });
  });

  it('ignores field order and empty skill lists when comparing values', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.findClaim).mockResolvedValue(
      claimRecord({
        claimType: 'employment',
        values: { startDate: '2021-03', jobTitle: 'Developer', employer: 'Aramex' }
      })
    );
    const service = createService(repository);

    await service.updateClaim(userId, claimId, {
      type: 'employment',
      values: {
        employer: 'Aramex',
        jobTitle: 'Developer',
        startDate: '2021-03',
        skills: []
      }
    });

    expect(repository.updateClaimValues).not.toHaveBeenCalled();
  });

  it('does not change the type of an existing claim', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await expect(
      service.updateClaim(userId, claimId, {
        type: 'certification',
        values: { title: 'Python', issuer: 'Python', issueDate: '2023-01' }
      })
    ).rejects.toBeInstanceOf(ClaimTypeMismatchError);
    expect(repository.updateClaimValues).not.toHaveBeenCalled();
  });

  it('hides claims owned by another candidate', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.findClaim).mockResolvedValue(null);
    vi.mocked(repository.deleteClaim).mockResolvedValue({ status: 'missing' });
    const service = createService(repository);

    await expect(
      service.updateClaim(userId, claimId, {
        type: 'skill',
        values: { name: 'Python' }
      })
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(service.deleteClaim(userId, claimId)).rejects.toBeInstanceOf(
      RecordNotFoundError
    );
    expect(repository.findClaim).toHaveBeenCalledWith(candidateId, claimId);
    expect(repository.deleteClaim).toHaveBeenCalledWith(candidateId, claimId, undefined);
  });

  it.each(['accepted', 'rejected'] as const)(
    'reviews a pending extracted claim as %s',
    async (status) => {
      const repository = createRepositoryDouble();
      const reviewed = extractedClaim(status, 2);
      vi.mocked(repository.reviewExtractedClaim).mockResolvedValue({
        status: 'saved',
        record: reviewed
      });
      const normalizer = createNormalizerDouble();
      const service = createService(repository, normalizer);

      await expect(
        service.reviewClaim(userId, claimId, { status }, 1)
      ).resolves.toBe(reviewed);
      expect(repository.reviewExtractedClaim).toHaveBeenCalledWith(
        candidateId,
        claimId,
        status,
        1
      );
      if (status === 'accepted') {
        expect(normalizer.normalizeClaim).toHaveBeenCalledWith(reviewed);
      } else {
        expect(normalizer.normalizeClaim).not.toHaveBeenCalled();
      }
    }
  );

  it('refuses a claim that is not pending and extracted', async () => {
    const repository = createRepositoryDouble();
    const current = claimRecord();
    vi.mocked(repository.reviewExtractedClaim).mockResolvedValue({
      status: 'not_reviewable',
      current
    });
    const service = createService(repository);

    const error = await service
      .reviewClaim(userId, claimId, { status: 'accepted' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaimNotReviewableError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'CLAIM_NOT_REVIEWABLE',
      details: { current }
    });
  });

  describe('versions', () => {
    it('refuses a claim edit based on an older version, even with equal values', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.findClaim).mockResolvedValue(claimRecord({ version: 2 }));
      const service = createService(repository);

      const error = await service
        .updateClaim(userId, claimId, { type: 'skill', values: { name: 'Python' } }, 1)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        details: { current: claimRecord({ version: 2 }) }
      });
      expect(repository.updateClaimValues).not.toHaveBeenCalled();
    });

    it('passes the expected version on to the claim edit', async () => {
      const repository = createRepositoryDouble();
      const service = createService(repository);

      await service.updateClaim(
        userId,
        claimId,
        { type: 'skill', values: { name: 'Go' } },
        1
      );

      expect(repository.updateClaimValues).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersion: 1 })
      );
    });

    it('reports a claim changed between reading and writing', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.updateClaimValues).mockResolvedValue({
        status: 'conflict',
        current: claimRecord({ version: 2 })
      });
      const service = createService(repository);

      await expect(
        service.updateClaim(userId, claimId, { type: 'skill', values: { name: 'Go' } }, 1)
      ).rejects.toBeInstanceOf(VersionConflictError);
    });

    it('reports a profile conflict with the current profile', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.updateCandidate).mockResolvedValue({
        status: 'conflict',
        current: { ...candidateRecord, version: 3 }
      });
      const service = createService(repository);

      const error = await service
        .updateProfile(userId, { headline: 'Engineer' }, 2)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error).toMatchObject({
        details: { current: { candidateId, version: 3, email: 'candidate@example.com' } }
      });
      expect(repository.updateCandidate).toHaveBeenCalledWith(
        candidateId,
        { headline: 'Engineer' },
        2
      );
    });

    it('refuses to delete a claim that changed', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.deleteClaim).mockResolvedValue({
        status: 'conflict',
        current: claimRecord({ version: 2 })
      });
      const service = createService(repository);

      await expect(service.deleteClaim(userId, claimId, 1)).rejects.toBeInstanceOf(
        VersionConflictError
      );
      expect(repository.deleteClaim).toHaveBeenCalledWith(candidateId, claimId, 1);
    });

    it('refuses to review a claim that changed', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.reviewExtractedClaim).mockResolvedValue({
        status: 'conflict',
        current: extractedClaim('pending', 2)
      });
      const service = createService(repository);

      await expect(
        service.reviewClaim(userId, claimId, { status: 'accepted' }, 1)
      ).rejects.toBeInstanceOf(VersionConflictError);
    });

    it('returns the profile version', async () => {
      const service = createService(createRepositoryDouble());

      await expect(service.getProfile(userId)).resolves.toMatchObject({ version: 1 });
    });
  });

  it('exports only accepted claims grouped by type', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.listClaims).mockResolvedValue([
      claimRecord(),
      claimRecord({
        claimId: '44444444-4444-4444-8444-444444444444',
        claimType: 'certification',
        values: { title: 'AWS', issuer: 'Amazon', issueDate: '2023-01' }
      }),
      claimRecord({
        claimId: '55555555-5555-4555-8555-555555555555',
        claimType: 'language',
        values: { name: 'English', proficiency: 'Native' }
      }),
      claimRecord({
        claimId: '66666666-6666-4666-8666-666666666666',
        claimType: 'project',
        values: { name: 'Shop API' }
      })
    ]);
    vi.mocked(repository.listClaimSourceOccurrences).mockResolvedValue([
      {
        occurrenceId: '77777777-7777-4777-8777-777777777777',
        claimId,
        documentId: '88888888-8888-4888-8888-888888888888',
        anchorKey: 'pdf:1:8',
        sourceReferences: ['L8'],
        fieldNames: ['name'],
        anchor: {
          kind: 'pdf_line',
          order: 8,
          pageNumber: 1,
          box: { x: 40, y: 80, width: 100, height: 12 },
          text: 'Python',
          links: []
        }
      },
      {
        occurrenceId: '99999999-9999-4999-8999-999999999999',
        claimId: '44444444-4444-4444-8444-444444444444',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        anchorKey: 'docx:block:4',
        sourceReferences: ['B4'],
        fieldNames: ['title', 'issuer'],
        anchor: {
          kind: 'docx_paragraph',
          blockIndex: 4,
          text: 'AWS — Amazon',
          links: []
        }
      }
    ]);
    const service = createService(repository);

    const result = await service.exportProfile(userId);

    expect(repository.listClaims).toHaveBeenCalledWith(candidateId, {
      status: ['accepted', 'auto_accepted']
    });
    expect(result.personalInfo).toEqual({
      fullName: 'Example Candidate',
      email: 'candidate@example.com',
      contactEmail: null,
      headline: 'Backend Developer',
      summary: null,
      phone: null,
      location: 'Amman',
      profileLinks: []
    });
    expect(repository.listClaimSourceOccurrences).toHaveBeenCalledWith(candidateId, [
      claimId,
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666'
    ]);
    expect(result.skills).toEqual([
      {
        claimId,
        name: 'Python',
        sources: [
          {
            documentId: '88888888-8888-4888-8888-888888888888',
            references: ['L8'],
            fields: ['name'],
            anchor: {
              kind: 'pdf_line',
              order: 8,
              pageNumber: 1,
              box: { x: 40, y: 80, width: 100, height: 12 },
              text: 'Python',
              links: []
            }
          }
        ]
      }
    ]);
    expect(Object.keys(result.skills[0] ?? {})[0]).toBe('claimId');
    expect(result.certifications).toEqual([
      {
        claimId: '44444444-4444-4444-8444-444444444444',
        title: 'AWS',
        issuer: 'Amazon',
        issueDate: '2023-01',
        sources: [
          {
            documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            references: ['B4'],
            fields: ['title', 'issuer'],
            anchor: {
              kind: 'docx_paragraph',
              blockIndex: 4,
              text: 'AWS — Amazon',
              links: []
            }
          }
        ]
      }
    ]);
    expect(result.languages).toEqual([
      {
        claimId: '55555555-5555-4555-8555-555555555555',
        name: 'English',
        proficiency: 'Native',
        sources: []
      }
    ]);
    expect(result.projects).toEqual([
      { claimId: '66666666-6666-4666-8666-666666666666', name: 'Shop API', sources: [] }
    ]);
    expect(result.employment).toEqual([]);
    expect(result.education).toEqual([]);
  });
});

describe('claim merge proposal service', () => {
  const otherClaimId = '44444444-4444-4444-8444-444444444444';

  it('maps stored claim authority and versions into a proposal', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.findClaim)
      .mockResolvedValueOnce(
        {
          ...extractedClaim('pending', 3),
          candidateEdited: true,
          values: { name: 'TypeScript' }
        }
      )
      .mockResolvedValueOnce(
        claimRecord({
          claimId: otherClaimId,
          origin: 'extracted',
          status: 'accepted',
          version: 5,
          values: { name: ' typescript ' }
        })
      );

    await expect(
      createService(repository).getClaimMergeProposal(
        userId,
        claimId,
        otherClaimId
      )
    ).resolves.toMatchObject({
      result: 'proposal',
      left: { claimId, version: 3 },
      right: { claimId: otherClaimId, version: 5 },
      survivorClaimId: claimId,
      survivorReason: 'candidate_authority',
      recommendedAction: 'candidate_review'
    });
  });

  it('refuses identical, rejected, and superseded claim pairs', async () => {
    const sameRepository = createRepositoryDouble();
    await expect(
      createService(sameRepository).getClaimMergeProposal(userId, claimId, claimId)
    ).resolves.toEqual({ result: 'no_proposal', reason: 'same_claim' });
    expect(sameRepository.findClaim).not.toHaveBeenCalled();

    const rejectedRepository = createRepositoryDouble();
    vi.mocked(rejectedRepository.findClaim)
      .mockResolvedValueOnce(claimRecord({ status: 'rejected' }))
      .mockResolvedValueOnce(claimRecord({ claimId: otherClaimId }));
    await expect(
      createService(rejectedRepository).getClaimMergeProposal(
        userId,
        claimId,
        otherClaimId
      )
    ).resolves.toEqual({ result: 'no_proposal', reason: 'rejected_claim' });

    const supersededRepository = createRepositoryDouble();
    vi.mocked(supersededRepository.findClaim)
      .mockResolvedValueOnce(
        claimRecord({ supersededByClaimId: otherClaimId })
      )
      .mockResolvedValueOnce(claimRecord({ claimId: otherClaimId }));
    await expect(
      createService(supersededRepository).getClaimMergeProposal(
        userId,
        claimId,
        otherClaimId
      )
    ).resolves.toEqual({ result: 'no_proposal', reason: 'superseded_claim' });
  });
});

describe('claim merge candidate discovery service', () => {
  it('uses AI to suppress close employment date ranges judged to be separate', async () => {
    const repository = createRepositoryDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(repository.listClaims).mockResolvedValue([
      claimRecord({
        claimType: 'employment',
        values: {
          employer: 'Example Labs',
          jobTitle: 'Engineer',
          startDate: '2020-01',
          endDate: '2024-01'
        }
      }),
      claimRecord({
        claimId: rightClaimId,
        claimType: 'employment',
        values: {
          employer: 'Example Labs',
          jobTitle: 'Engineer',
          startDate: '2020-02',
          endDate: '2024-02'
        }
      })
    ]);
    const judge = vi.fn<DuplicateJudge['judge']>().mockResolvedValue({
      status: 'different',
      confidence: 0.94,
      reason: 'These are separate roles.'
    });
    const service = createService(
      repository,
      createNormalizerDouble(),
      { warn: vi.fn() },
      { judge }
    );

    await expect(service.listClaimMergeCandidates(userId)).resolves.toEqual([]);
    expect(judge).toHaveBeenCalledOnce();
  });

  describe('records named differently with close dates', () => {
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    const rewordedRoles = () => [
      claimRecord({
        claimType: 'employment',
        origin: 'extracted',
        status: 'pending',
        current: true,
        values: {
          employer: 'Arowwai Industries',
          jobTitle: 'Administrative Employee',
          startDate: '2023-10'
        }
      }),
      claimRecord({
        claimId: rightClaimId,
        claimType: 'employment',
        origin: 'extracted',
        status: 'pending',
        current: true,
        values: {
          employer: 'Arowwai Industries',
          jobTitle: 'Administrative Operations Specialist',
          startDate: '2023-10'
        }
      })
    ];

    it('offers them to the candidate when AI finds them the same', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.listClaims).mockResolvedValue(rewordedRoles());
      const judge = vi.fn<DuplicateJudge['judge']>().mockResolvedValue({
        status: 'merge_candidate',
        confidence: 0.92,
        reason: 'The same role described with a reworded title.'
      });
      const service = createService(
        repository,
        createNormalizerDouble(),
        { warn: vi.fn() },
        { judge }
      );

      await expect(service.listClaimMergeCandidates(userId)).resolves.toMatchObject([
        {
          result: 'proposal',
          identity: 'possible_duplicate',
          recommendedAction: 'candidate_review',
          unresolvedFields: ['jobTitle']
        }
      ]);
      vi.mocked(repository.findClaim).mockImplementation(async (_, id) =>
        rewordedRoles().find((claim) => claim.claimId === id) ?? null
      );
      await expect(
        service.getClaimMergeProposal(userId, claimId, rightClaimId)
      ).resolves.toMatchObject({ result: 'proposal', identity: 'possible_duplicate' });
      // The verdict is cached for the same claim versions.
      expect(judge).toHaveBeenCalledOnce();
    });

    it.each([
      ['finds them different', { status: 'different', confidence: 0.9, reason: 'Two roles.' }],
      ['is uncertain', { status: 'uncertain', reason: 'Not enough evidence.' }]
    ] as const)('does not offer them when AI %s', async (_, judgment) => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.listClaims).mockResolvedValue(rewordedRoles());
      const judge = vi.fn<DuplicateJudge['judge']>().mockResolvedValue(judgment);

      await expect(
        createService(
          repository,
          createNormalizerDouble(),
          { warn: vi.fn() },
          { judge }
        ).listClaimMergeCandidates(userId)
      ).resolves.toEqual([]);
    });

    it('does not offer them when AI fails or is not configured', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.listClaims).mockResolvedValue(rewordedRoles());
      const logger = { warn: vi.fn() };
      const judge = vi
        .fn<DuplicateJudge['judge']>()
        .mockRejectedValue(new Error('provider unavailable'));

      await expect(
        createService(repository, createNormalizerDouble(), logger, {
          judge
        }).listClaimMergeCandidates(userId)
      ).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalledOnce();
      await expect(
        createService(repository).listClaimMergeCandidates(userId)
      ).resolves.toEqual([]);
    });

    it('asks AI again after a failed judgment', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.listClaims).mockResolvedValue(rewordedRoles());
      const judge = vi
        .fn<DuplicateJudge['judge']>()
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValue({
          status: 'merge_candidate',
          confidence: 0.95,
          reason: 'The same role.'
        });
      const service = createService(
        repository,
        createNormalizerDouble(),
        { warn: vi.fn() },
        { judge }
      );

      await expect(service.listClaimMergeCandidates(userId)).resolves.toEqual([]);
      await expect(service.listClaimMergeCandidates(userId)).resolves.toHaveLength(1);
      await expect(service.listClaimMergeCandidates(userId)).resolves.toHaveLength(1);
      expect(judge).toHaveBeenCalledTimes(2);
    });

    it('does not ask AI about consecutive roles at one employer', async () => {
      const repository = createRepositoryDouble();
      vi.mocked(repository.listClaims).mockResolvedValue([
        claimRecord({
          claimType: 'employment',
          values: {
            employer: 'Arowwai Industries',
            jobTitle: 'Office Coordinator',
            startDate: '2020-10',
            endDate: '2021-10'
          }
        }),
        claimRecord({
          claimId: rightClaimId,
          claimType: 'employment',
          values: {
            employer: 'Arowwai Industries',
            jobTitle: 'HR & Employee Support',
            startDate: '2021-10',
            endDate: '2023-10'
          }
        })
      ]);
      const judge = vi.fn<DuplicateJudge['judge']>();

      await expect(
        createService(
          repository,
          createNormalizerDouble(),
          { warn: vi.fn() },
          { judge }
        ).listClaimMergeCandidates(userId)
      ).resolves.toEqual([]);
      expect(judge).not.toHaveBeenCalled();
    });
  });

  it('retains close education ranges approved or left uncertain by AI', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.listClaims).mockResolvedValue([
      claimRecord({
        claimType: 'education',
        values: {
          institution: 'Example University',
          degree: 'BSc',
          startDate: '2020-09',
          endDate: '2024-06'
        }
      }),
      claimRecord({
        claimId: '44444444-4444-4444-8444-444444444444',
        claimType: 'education',
        values: {
          institution: 'Example University',
          degree: 'BSc',
          startDate: '2021-01',
          endDate: '2024-08'
        }
      })
    ]);
    const judge = vi.fn<DuplicateJudge['judge']>().mockResolvedValue({
      status: 'merge_candidate',
      confidence: 0.9,
      reason: 'The dates plausibly describe the same program.'
    });

    await expect(
      createService(
        repository,
        createNormalizerDouble(),
        { warn: vi.fn() },
        { judge }
      ).listClaimMergeCandidates(userId)
    ).resolves.toMatchObject([
      { result: 'proposal', identity: 'suspected_duplicate' }
    ]);
  });

  it('returns each active same-type duplicate pair once in stable order', async () => {
    const repository = createRepositoryDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(repository.listClaims).mockResolvedValue([
      claimRecord({
        claimId: '66666666-6666-4666-8666-666666666666',
        claimType: 'language',
        status: 'rejected',
        values: { name: 'English', proficiency: 'Native' }
      }),
      claimRecord({
        claimId: rightClaimId,
        claimType: 'language',
        values: { name: 'English', proficiency: 'Native' }
      }),
      claimRecord({
        claimId: '11111111-1111-4111-8111-111111111111',
        claimType: 'skill',
        values: { name: 'English' }
      }),
      claimRecord({
        claimType: 'language',
        values: { name: 'English', proficiency: 'Professional' }
      }),
      claimRecord({
        claimId: '55555555-5555-4555-8555-555555555555',
        claimType: 'language',
        supersededByClaimId: rightClaimId,
        values: { name: 'English' }
      }),
      claimRecord({
        claimId: '77777777-7777-4777-8777-777777777777',
        claimType: 'language',
        values: { name: 'French' }
      })
    ]);

    await expect(
      createService(repository).listClaimMergeCandidates(userId)
    ).resolves.toMatchObject([
      {
        result: 'proposal',
        left: { claimId },
        right: { claimId: rightClaimId },
        unresolvedFields: ['proficiency'],
        recommendedAction: 'candidate_review'
      }
    ]);
    expect(repository.listClaims).toHaveBeenCalledWith(candidateId);
  });

  it('lists claims with the canonical name their value is shown as', async () => {
    const repository = createRepositoryDouble();
    const pyton = claimRecord({ values: { name: 'Pyton' } });
    const kotlin = claimRecord({
      claimId: '44444444-4444-4444-8444-444444444444',
      values: { name: 'Kotlin' }
    });
    vi.mocked(repository.listClaims).mockResolvedValue([pyton, kotlin]);
    const normalizer = createNormalizerDouble();
    const normalized = {
      name: { value: 'Python', original: 'Pyton', method: 'fuzzy', confidence: 0.83 }
    };
    vi.mocked(normalizer.describeNormalizedValues).mockResolvedValue(
      new Map([[pyton.claimId, normalized]])
    );

    await expect(
      createService(repository, normalizer).listClaims(userId, {})
    ).resolves.toEqual([{ ...pyton, normalized }, kotlin]);
  });

  it('lists claims as written when canonical names cannot be loaded', async () => {
    const repository = createRepositoryDouble();
    const pyton = claimRecord({ values: { name: 'Pyton' } });
    vi.mocked(repository.listClaims).mockResolvedValue([pyton]);
    const normalizer = createNormalizerDouble();
    vi.mocked(normalizer.describeNormalizedValues).mockRejectedValue(new Error('offline'));
    const logger = { warn: vi.fn() };

    await expect(
      createService(repository, normalizer, logger).listClaims(userId, {})
    ).resolves.toEqual([pyton]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('lists and merges skills linked to the same canonical term', async () => {
    const otherClaimId = '44444444-4444-4444-8444-444444444444';
    const repository = createRepositoryDouble();
    const left = claimRecord({ values: { name: 'JS' } });
    const right = claimRecord({
      claimId: otherClaimId,
      version: 4,
      values: { name: 'JavaScript' }
    });
    vi.mocked(repository.listClaims).mockResolvedValue([left, right]);
    vi.mocked(repository.findClaim).mockImplementation(async (_candidateId, id) =>
      id === left.claimId ? left : right
    );
    vi.mocked(repository.mergeConfirmedClaims).mockResolvedValue({
      status: 'saved',
      survivor: { ...right, version: 5 },
      duplicate: { ...left, supersededByClaimId: otherClaimId }
    });
    const normalizer = createNormalizerDouble();
    vi.mocked(normalizer.findNormalizedTerms).mockResolvedValue(
      new Map([
        [left.claimId, { name: 't-js' }],
        [otherClaimId, { name: 't-js' }]
      ])
    );
    const service = createService(repository, normalizer);

    await expect(service.listClaimMergeCandidates(userId)).resolves.toMatchObject([
      { result: 'proposal', identity: 'equivalent', unresolvedFields: [] }
    ]);
    await expect(
      service.mergeConfirmedClaims(userId, {
        leftClaimId: left.claimId,
        rightClaimId: otherClaimId,
        leftVersion: left.version,
        rightVersion: 4,
        survivorClaimId: otherClaimId,
        values: { name: 'JavaScript' }
      })
    ).resolves.toMatchObject({ result: 'merged' });
  });

  it('compares written values when normalized terms cannot be loaded', async () => {
    const otherClaimId = '44444444-4444-4444-8444-444444444444';
    const repository = createRepositoryDouble();
    vi.mocked(repository.listClaims).mockResolvedValue([
      claimRecord({ values: { name: 'TypeScript' } }),
      claimRecord({ claimId: otherClaimId, values: { name: 'typescript' } })
    ]);
    const normalizer = createNormalizerDouble();
    vi.mocked(normalizer.findNormalizedTerms).mockRejectedValue(new Error('offline'));
    const logger = { warn: vi.fn() };

    await expect(
      createService(repository, normalizer, logger).listClaimMergeCandidates(userId)
    ).resolves.toMatchObject([{ result: 'proposal', identity: 'equivalent' }]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns no candidates when no pair has matching identity', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.listClaims).mockResolvedValue([
      claimRecord({ values: { name: 'TypeScript' } }),
      claimRecord({
        claimId: '44444444-4444-4444-8444-444444444444',
        values: { name: 'PostgreSQL' }
      })
    ]);

    await expect(
      createService(repository).listClaimMergeCandidates(userId)
    ).resolves.toEqual([]);
  });

  it('suppresses only the exact claim versions marked different', async () => {
    const repository = createRepositoryDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    const claims = [
      claimRecord({
        version: 2,
        claimType: 'language',
        values: { name: 'English', proficiency: 'Professional' }
      }),
      claimRecord({
        claimId: rightClaimId,
        version: 4,
        claimType: 'language',
        values: { name: 'English', proficiency: 'Native' }
      })
    ];
    const decision = {
      decisionId: '55555555-5555-4555-8555-555555555555',
      candidateId,
      leftClaimId: claimId,
      rightClaimId,
      leftVersion: 2,
      rightVersion: 4,
      decision: 'different' as const,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    vi.mocked(repository.listClaims).mockResolvedValue(claims);
    vi.mocked(repository.listClaimPairDecisions)
      .mockResolvedValueOnce([decision])
      .mockResolvedValueOnce([{ ...decision, rightVersion: 3 }]);
    const service = createService(repository);

    await expect(service.listClaimMergeCandidates(userId)).resolves.toEqual([]);
    await expect(
      service.listClaimMergeCandidates(userId)
    ).resolves.toHaveLength(1);
  });
});

describe('recording different claim decisions', () => {
  const otherClaimId = '44444444-4444-4444-8444-444444444444';

  function duplicatePair(repository: CandidatesRepository, leftVersion = 2) {
    const left = claimRecord({
      version: leftVersion,
      claimType: 'language',
      values: { name: 'English', proficiency: 'Professional' }
    });
    const right = claimRecord({
      claimId: otherClaimId,
      version: 4,
      claimType: 'language',
      values: { name: 'English', proficiency: 'Native' }
    });
    vi.mocked(repository.findClaim)
      .mockResolvedValueOnce(left)
      .mockResolvedValueOnce(right);
    return { left, right };
  }

  it('records a freshly reviewed duplicate pair as different', async () => {
    const repository = createRepositoryDouble();
    duplicatePair(repository);
    vi.mocked(repository.recordClaimsDifferent).mockResolvedValue({
      status: 'saved'
    });

    await expect(
      createService(repository).recordClaimsDifferent(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 2,
        rightVersion: 4
      })
    ).resolves.toEqual({ result: 'recorded' });
    expect(repository.recordClaimsDifferent).toHaveBeenCalledWith({
      candidateId,
      left: { claimId, expectedVersion: 2 },
      right: { claimId: otherClaimId, expectedVersion: 4 }
    });
  });

  it('rejects stale reviewed versions before persistence', async () => {
    const repository = createRepositoryDouble();
    duplicatePair(repository, 3);

    await expect(
      createService(repository).recordClaimsDifferent(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 2,
        rightVersion: 4
      })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(repository.recordClaimsDifferent).not.toHaveBeenCalled();
  });

  it('does not persist claims with different identities', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.findClaim)
      .mockResolvedValueOnce(claimRecord({ values: { name: 'TypeScript' } }))
      .mockResolvedValueOnce(
        claimRecord({
          claimId: otherClaimId,
          version: 4,
          values: { name: 'PostgreSQL' }
        })
      );

    await expect(
      createService(repository).recordClaimsDifferent(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 1,
        rightVersion: 4
      })
    ).resolves.toEqual({
      result: 'no_decision',
      reason: 'different_identity'
    });
    expect(repository.recordClaimsDifferent).not.toHaveBeenCalled();
  });
});

describe('automatic claim coalesce service', () => {
  const otherClaimId = '44444444-4444-4444-8444-444444444444';

  function safePair(repository: CandidatesRepository) {
    const left = {
      ...extractedClaim('pending', 2),
      values: { name: 'TypeScript' }
    };
    const right = {
      ...extractedClaim('pending', 4),
      claimId: otherClaimId,
      values: { name: ' typescript ' }
    };
    vi.mocked(repository.findClaim)
      .mockResolvedValueOnce(left)
      .mockResolvedValueOnce(right);
    return { left, right };
  }

  it('executes only a freshly built safe automatic plan', async () => {
    const repository = createRepositoryDouble();
    const { left, right } = safePair(repository);
    vi.mocked(repository.coalescePendingClaims).mockResolvedValue({
      status: 'saved',
      survivor: { ...left, version: 3 },
      duplicate: { ...right, version: 5, supersededByClaimId: claimId }
    });

    await expect(
      createService(repository).coalescePendingClaims(
        userId,
        claimId,
        otherClaimId
      )
    ).resolves.toMatchObject({
      result: 'coalesced',
      survivor: { claimId, version: 3 },
      duplicate: { claimId: otherClaimId, supersededByClaimId: claimId }
    });
    expect(repository.coalescePendingClaims).toHaveBeenCalledWith({
      candidateId,
      survivor: { claimId, expectedVersion: 2 },
      duplicate: { claimId: otherClaimId, expectedVersion: 4 },
      values: { name: 'TypeScript' },
      messages: ['Combined sources']
    });
  });

  it('keeps unsafe pairs in candidate review without writing', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.findClaim)
      .mockResolvedValueOnce(extractedClaim('accepted', 2))
      .mockResolvedValueOnce(
        claimRecord({
          ...extractedClaim('pending', 4),
          claimId: otherClaimId
        })
      );

    await expect(
      createService(repository).coalescePendingClaims(
        userId,
        claimId,
        otherClaimId
      )
    ).resolves.toEqual({ result: 'candidate_review_required' });
    expect(repository.coalescePendingClaims).not.toHaveBeenCalled();
  });

  it('translates a stale transaction result into a version conflict', async () => {
    const repository = createRepositoryDouble();
    const { left, right } = safePair(repository);
    vi.mocked(repository.coalescePendingClaims).mockResolvedValue({
      status: 'conflict',
      current: [{ ...left, version: 3 }, right]
    });

    await expect(
      createService(repository).coalescePendingClaims(
        userId,
        claimId,
        otherClaimId
      )
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

describe('automatic duplicate merge after extraction', () => {
  const otherClaimId = '44444444-4444-4444-8444-444444444444';

  function equivalentPendingPair(): ClaimRecord[] {
    return [
      { ...extractedClaim('pending', 2), values: { name: 'TypeScript' } },
      {
        ...extractedClaim('pending', 4),
        claimId: otherClaimId,
        values: { name: ' typescript ' }
      }
    ];
  }

  it('merges a safe pair and loads normalized terms once for all claims', async () => {
    const repository = createRepositoryDouble();
    const normalizer = createNormalizerDouble();
    const pair = equivalentPendingPair();
    vi.mocked(repository.listClaims).mockResolvedValue(pair);
    vi.mocked(repository.autoAcceptMergeClaims).mockResolvedValue({
      status: 'saved',
      survivor: { ...pair[0]!, status: 'auto_accepted', version: 3 },
      duplicate: { ...pair[1]!, supersededByClaimId: claimId, version: 5 },
      notice: {
        noticeId: '66666666-6666-4666-8666-666666666666',
        candidateId,
        survivorClaimId: claimId,
        supersededClaimIds: [otherClaimId],
        messages: ['Combined sources'],
        claimsBefore: [],
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
        acknowledgedAt: null
      }
    });

    await expect(
      createService(repository, normalizer).autoAcceptHighConfidenceDuplicates(userId)
    ).resolves.toEqual({ applied: 1, skipped: 0 });
    expect(normalizer.findNormalizedTerms).toHaveBeenCalledTimes(1);
    expect(normalizer.findNormalizedTerms).toHaveBeenCalledWith(pair);
    expect(repository.autoAcceptMergeClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId,
        survivor: { claimId, expectedVersion: 2 },
        duplicate: { claimId: otherClaimId, expectedVersion: 4 }
      })
    );
  });

  it('never merges a pair the candidate called different, even after either changed', async () => {
    const repository = createRepositoryDouble();
    vi.mocked(repository.listClaims).mockResolvedValue(equivalentPendingPair());
    vi.mocked(repository.listClaimPairDecisions).mockResolvedValue([
      {
        decisionId: '55555555-5555-4555-8555-555555555555',
        candidateId,
        leftClaimId: otherClaimId,
        rightClaimId: claimId,
        leftVersion: 1,
        rightVersion: 1,
        decision: 'different',
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]);

    await expect(
      createService(repository).autoAcceptHighConfidenceDuplicates(userId)
    ).resolves.toEqual({ applied: 0, skipped: 1 });
    expect(repository.autoAcceptMergeClaims).not.toHaveBeenCalled();
  });
});

describe('confirmed claim merge service', () => {
  const otherClaimId = '44444444-4444-4444-8444-444444444444';

  function languagePair(repository: CandidatesRepository) {
    const left = extractedClaim('pending', 2);
    left.claimType = 'language';
    left.values = { name: 'English', proficiency: 'Professional' };
    const right = {
      ...extractedClaim('accepted', 4),
      claimId: otherClaimId,
      claimType: 'language' as const,
      values: { name: 'English', proficiency: 'Native' }
    };
    vi.mocked(repository.findClaim)
      .mockResolvedValueOnce(left)
      .mockResolvedValueOnce(right);
    return { left, right };
  }

  it('validates choices and executes a ready confirmed merge', async () => {
    const repository = createRepositoryDouble();
    const { left, right } = languagePair(repository);
    vi.mocked(repository.mergeConfirmedClaims).mockResolvedValue({
      status: 'saved',
      survivor: { ...right, version: 5 },
      duplicate: { ...left, version: 3, supersededByClaimId: otherClaimId }
    });

    await expect(
      createService(repository).mergeConfirmedClaims(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 2,
        rightVersion: 4,
        survivorClaimId: otherClaimId,
        values: { name: ' English ', proficiency: 'Native' }
      })
    ).resolves.toMatchObject({
      result: 'merged',
      survivor: { claimId: otherClaimId, version: 5 },
      duplicate: { claimId, supersededByClaimId: otherClaimId }
    });
    expect(repository.mergeConfirmedClaims).toHaveBeenCalledWith({
      candidateId,
      survivor: { claimId: otherClaimId, expectedVersion: 4 },
      duplicate: { claimId, expectedVersion: 2 },
      values: { name: 'English', proficiency: 'Native' }
    });
  });

  it('refuses unresolved choices without writing', async () => {
    const repository = createRepositoryDouble();
    languagePair(repository);

    await expect(
      createService(repository).mergeConfirmedClaims(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 2,
        rightVersion: 4,
        survivorClaimId: claimId,
        values: { name: 'English' }
      })
    ).resolves.toEqual({
      result: 'invalid_resolution',
      reason: 'missing_field_choice',
      fields: ['proficiency']
    });
    expect(repository.mergeConfirmedClaims).not.toHaveBeenCalled();
  });

  it('translates reviewed and transactional version conflicts', async () => {
    const reviewedRepository = createRepositoryDouble();
    languagePair(reviewedRepository);
    await expect(
      createService(reviewedRepository).mergeConfirmedClaims(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 1,
        rightVersion: 4,
        survivorClaimId: claimId,
        values: { name: 'English', proficiency: 'Native' }
      })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(reviewedRepository.mergeConfirmedClaims).not.toHaveBeenCalled();

    const transactionRepository = createRepositoryDouble();
    const { left, right } = languagePair(transactionRepository);
    vi.mocked(transactionRepository.mergeConfirmedClaims).mockResolvedValue({
      status: 'conflict',
      current: [{ ...left, version: 3 }, right]
    });
    await expect(
      createService(transactionRepository).mergeConfirmedClaims(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 2,
        rightVersion: 4,
        survivorClaimId: claimId,
        values: { name: 'English', proficiency: 'Native' }
      })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('validates final claim values before persistence', async () => {
    const repository = createRepositoryDouble();
    languagePair(repository);

    await expect(
      createService(repository).mergeConfirmedClaims(userId, {
        leftClaimId: claimId,
        rightClaimId: otherClaimId,
        leftVersion: 2,
        rightVersion: 4,
        survivorClaimId: claimId,
        values: { proficiency: 'Native' }
      })
    ).rejects.toMatchObject({ code: 'INVALID_CLAIM_VALUES' });
    expect(repository.mergeConfirmedClaims).not.toHaveBeenCalled();
  });
});

describe('claim batch resolution service', () => {
  const secondClaimId = '44444444-4444-4444-8444-444444444444';
  const thirdClaimId = '55555555-5555-4555-8555-555555555555';
  const fourthClaimId = '66666666-6666-4666-8666-666666666666';
  const fifthClaimId = '77777777-7777-4777-8777-777777777777';

  it('merges a connected claim group through one repository operation', async () => {
    const repository = createRepositoryDouble();
    const groupClaims = [
      claimRecord({
        claimId,
        claimType: 'language',
        version: 2,
        values: { name: 'English', proficiency: 'Native' }
      }),
      claimRecord({
        claimId: secondClaimId,
        claimType: 'language',
        version: 4,
        values: { name: 'English', proficiency: 'C1' }
      }),
      claimRecord({
        claimId: thirdClaimId,
        claimType: 'language',
        version: 3,
        values: { name: 'English', proficiency: 'Fluent' }
      })
    ];
    vi.mocked(repository.findClaim).mockImplementation(
      async (_candidateId, requestedClaimId) =>
        groupClaims.find(({ claimId }) => claimId === requestedClaimId) ?? null
    );
    vi.mocked(repository.mergeConfirmedClaimGroup).mockResolvedValue({
      status: 'saved',
      survivor: claimRecord({
        claimId,
        claimType: 'language',
        version: 3,
        values: { name: 'English', proficiency: 'Native' }
      }),
      duplicates: [
        claimRecord({ claimId: secondClaimId, supersededByClaimId: claimId }),
        claimRecord({ claimId: thirdClaimId, supersededByClaimId: claimId })
      ]
    });

    await expect(
      createService(repository).mergeConfirmedClaimGroup(userId, {
        claims: [
          { claimId, version: 2 },
          { claimId: secondClaimId, version: 4 },
          { claimId: thirdClaimId, version: 3 }
        ],
        survivorClaimId: claimId,
        values: { name: 'English', proficiency: 'Native' }
      })
    ).resolves.toMatchObject({
      result: 'merged',
      survivor: { claimId },
      duplicates: [{ claimId: secondClaimId }, { claimId: thirdClaimId }]
    });
    expect(repository.mergeConfirmedClaimGroup).toHaveBeenCalledWith({
      candidateId,
      claims: [
        { claimId, expectedVersion: 2 },
        { claimId: secondClaimId, expectedVersion: 4 },
        { claimId: thirdClaimId, expectedVersion: 3 }
      ],
      survivorClaimId: claimId,
      values: { name: 'English', proficiency: 'Native' }
    });
  });

  it('does not persist a disconnected claim group', async () => {
    const repository = createRepositoryDouble();
    const groupClaims = [
      claimRecord({ claimId, values: { name: 'TypeScript' } }),
      claimRecord({ claimId: secondClaimId, values: { name: 'TypeScript' } }),
      claimRecord({ claimId: thirdClaimId, values: { name: 'Rust' } })
    ];
    vi.mocked(repository.findClaim).mockImplementation(
      async (_candidateId, requestedClaimId) =>
        groupClaims.find(({ claimId }) => claimId === requestedClaimId) ?? null
    );

    await expect(
      createService(repository).mergeConfirmedClaimGroup(userId, {
        claims: groupClaims.map(({ claimId, version }) => ({ claimId, version })),
        survivorClaimId: claimId,
        values: { name: 'TypeScript' }
      })
    ).resolves.toEqual({
      result: 'not_eligible',
      reason: 'disconnected_claim_group'
    });
    expect(repository.mergeConfirmedClaimGroup).not.toHaveBeenCalled();
  });

  it('reports a version conflict before persisting a claim group', async () => {
    const repository = createRepositoryDouble();
    const groupClaims = [
      claimRecord({ claimId, version: 2, values: { name: 'TypeScript' } }),
      claimRecord({
        claimId: secondClaimId,
        version: 5,
        values: { name: 'typescript' }
      })
    ];
    vi.mocked(repository.findClaim).mockImplementation(
      async (_candidateId, requestedClaimId) =>
        groupClaims.find(({ claimId }) => claimId === requestedClaimId) ?? null
    );

    await expect(
      createService(repository).mergeConfirmedClaimGroup(userId, {
        claims: [
          { claimId, version: 2 },
          { claimId: secondClaimId, version: 4 }
        ],
        survivorClaimId: claimId,
        values: { name: 'TypeScript' }
      })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(repository.mergeConfirmedClaimGroup).not.toHaveBeenCalled();
  });

  it('returns an accepted group result from batch resolution', async () => {
    const service = createService(createRepositoryDouble());
    vi.spyOn(service, 'mergeConfirmedClaimGroup').mockResolvedValue({
      result: 'merged',
      survivor: claimRecord({ claimId }),
      duplicates: [
        claimRecord({ claimId: secondClaimId, supersededByClaimId: claimId }),
        claimRecord({ claimId: thirdClaimId, supersededByClaimId: claimId })
      ]
    });
    const action = {
      action: 'merge_claim_group' as const,
      claims: [
        { claimId, version: 1 },
        { claimId: secondClaimId, version: 1 },
        { claimId: thirdClaimId, version: 1 }
      ],
      survivorClaimId: claimId,
      values: { name: 'TypeScript' }
    };

    await expect(service.resolveClaimBatch(userId, [action])).resolves.toMatchObject([
      {
        index: 0,
        action: 'merge_claim_group',
        status: 'accepted',
        survivor: { claimId },
        duplicates: [{ claimId: secondClaimId }, { claimId: thirdClaimId }]
      }
    ]);
  });

  it('preserves input order across mixed independent outcomes', async () => {
    const service = createService(createRepositoryDouble());
    vi.spyOn(service, 'reviewClaim')
      .mockResolvedValueOnce(claimRecord({ status: 'accepted', version: 2 }))
      .mockRejectedValueOnce(
        new VersionConflictError('Claim', claimRecord({ version: 3 }))
      )
      .mockRejectedValueOnce(new RecordNotFoundError('Claim', fifthClaimId));
    vi.spyOn(service, 'mergeConfirmedClaims').mockResolvedValue({
      result: 'not_eligible'
    });

    await expect(
      service.resolveClaimBatch(userId, [
        { action: 'accept_claim', claimId, version: 1 },
        {
          action: 'merge_claims',
          leftClaimId: secondClaimId,
          rightClaimId: thirdClaimId,
          leftVersion: 2,
          rightVersion: 4,
          survivorClaimId: secondClaimId,
          values: { name: 'TypeScript' }
        },
        { action: 'accept_claim', claimId: fourthClaimId, version: 2 },
        { action: 'accept_claim', claimId: fifthClaimId, version: 1 }
      ])
    ).resolves.toMatchObject([
      { index: 0, action: 'accept_claim', status: 'accepted' },
      {
        index: 1,
        action: 'merge_claims',
        status: 'not_eligible',
        reason: 'not_eligible'
      },
      { index: 2, action: 'accept_claim', status: 'conflict' },
      {
        index: 3,
        action: 'accept_claim',
        status: 'failed',
        code: 'RECORD_NOT_FOUND'
      }
    ]);
  });

  it('rejects overlapping claims before starting any action', async () => {
    const service = createService(createRepositoryDouble());
    const review = vi.spyOn(service, 'reviewClaim');
    const merge = vi.spyOn(service, 'mergeConfirmedClaims');

    await expect(
      service.resolveClaimBatch(userId, [
        { action: 'accept_claim', claimId, version: 1 },
        {
          action: 'merge_claims',
          leftClaimId: claimId,
          rightClaimId: secondClaimId,
          leftVersion: 1,
          rightVersion: 1,
          survivorClaimId: claimId,
          values: { name: 'TypeScript' }
        }
      ])
    ).rejects.toMatchObject({
      code: 'OVERLAPPING_BATCH_CLAIMS',
      details: { claimIds: [claimId] }
    });
    expect(review).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('rejects a group that overlaps another batch action', async () => {
    const service = createService(createRepositoryDouble());
    const review = vi.spyOn(service, 'reviewClaim');
    const mergeGroup = vi.spyOn(service, 'mergeConfirmedClaimGroup');

    await expect(
      service.resolveClaimBatch(userId, [
        { action: 'accept_claim', claimId, version: 1 },
        {
          action: 'merge_claim_group',
          claims: [
            { claimId, version: 1 },
            { claimId: secondClaimId, version: 1 },
            { claimId: thirdClaimId, version: 1 }
          ],
          survivorClaimId: claimId,
          values: { name: 'TypeScript' }
        }
      ])
    ).rejects.toMatchObject({
      code: 'OVERLAPPING_BATCH_CLAIMS',
      details: { claimIds: [claimId] }
    });
    expect(review).not.toHaveBeenCalled();
    expect(mergeGroup).not.toHaveBeenCalled();
  });

  it('runs at most five independent actions concurrently', async () => {
    const service = createService(createRepositoryDouble());
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    vi.spyOn(service, 'reviewClaim').mockImplementation(
      (_userId, actionClaimId) =>
        new Promise<ClaimRecord>((resolve) => {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(
              claimRecord({ claimId: actionClaimId, status: 'accepted' })
            );
          });
        })
    );
    const actions = Array.from({ length: 6 }, (_, index) => ({
      action: 'accept_claim' as const,
      claimId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      version: 1
    }));

    const resultPromise = service.resolveClaimBatch(userId, actions);
    await vi.waitFor(() => expect(started).toBe(5));
    expect(maximumActive).toBe(5);
    expect(releases).toHaveLength(5);
    releases.forEach((release) => release());
    await vi.waitFor(() => expect(started).toBe(6));
    releases[5]?.();

    await expect(resultPromise).resolves.toHaveLength(6);
    expect(maximumActive).toBe(5);
  });
});

describe('keeping automatic merges separate', () => {
  it('restores the original claims through the repository', async () => {
    const repository = createRepositoryDouble();
    const restored = [
      claimRecord({ status: 'pending', version: 3 }),
      claimRecord({
        claimId: '44444444-4444-4444-8444-444444444444',
        status: 'pending',
        version: 2
      })
    ];
    vi.mocked(repository.keepAutoMergedClaimsSeparate).mockResolvedValue({
      status: 'saved',
      claims: restored
    });

    await expect(
      createService(repository).keepAutoMergedClaimsSeparate(userId, claimId, 2)
    ).resolves.toEqual({ claims: restored });
    expect(repository.keepAutoMergedClaimsSeparate).toHaveBeenCalledWith(
      candidateId,
      claimId,
      2
    );
  });

  it('reports a stale survivor as a version conflict', async () => {
    const repository = createRepositoryDouble();
    const current = [claimRecord({ status: 'auto_accepted', version: 4 })];
    vi.mocked(repository.keepAutoMergedClaimsSeparate).mockResolvedValue({
      status: 'conflict',
      current
    });

    await expect(
      createService(repository).keepAutoMergedClaimsSeparate(userId, claimId, 2)
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { current }
    });
  });
});

function createAuthRepositoryDouble(role: UserRole): AuthRepository {
  const state = { userId, role, accountStatus: 'active' as const, tokenVersion: 0 };

  return {
    createCandidate: vi.fn().mockResolvedValue(state),
    findCredentialsByEmail: vi.fn().mockResolvedValue(null),
    getTokenVersion: vi.fn().mockResolvedValue(0),
    getAuthState: vi.fn().mockResolvedValue(state),
    incrementTokenVersion: vi.fn().mockResolvedValue(1)
  };
}

function createJwtDouble(role: UserRole): JwtService {
  return {
    issueAccessToken: vi.fn().mockResolvedValue('access-token'),
    verifyAccessToken: vi.fn().mockResolvedValue({ userId, role, tokenVersion: 0 }),
    issueRefreshToken: vi.fn().mockResolvedValue('refresh-token'),
    verifyRefreshToken: vi.fn().mockResolvedValue({ userId, role, tokenVersion: 0 })
  };
}

const profile: CandidateProfile = {
  candidateId,
  fullName: 'Example Candidate',
  email: 'candidate@example.com',
  headline: null,
  summary: null,
  phone: null,
  location: null,
  contactEmail: null,
  profileLinks: [],
  version: 4,
  createdAt: timestamp,
  updatedAt: timestamp
};

function createServiceDouble(): CandidatesService {
  return {
    createProfile: vi.fn(),
    getProfile: vi.fn().mockResolvedValue(profile),
    updateProfile: vi.fn().mockResolvedValue(profile),
    createClaim: vi.fn().mockResolvedValue(claimRecord()),
    listClaims: vi.fn().mockResolvedValue([claimRecord()]),
    getClaim: vi.fn().mockResolvedValue(claimRecord()),
    getClaimMergeProposal: vi.fn(),
    listClaimMergeCandidates: vi.fn(),
    recordClaimsDifferent: vi.fn(),
    coalescePendingClaims: vi.fn(),
    mergeConfirmedClaims: vi.fn(),
    mergeConfirmedClaimGroup: vi.fn(),
    resolveClaimBatch: vi.fn(),
    updateClaim: vi.fn().mockResolvedValue(claimRecord()),
    reviewClaim: vi.fn().mockResolvedValue(extractedClaim('accepted', 2)),
    deleteClaim: vi.fn().mockResolvedValue(undefined),
    exportProfile: vi.fn(),
    autoAcceptMergeClaims: vi.fn(),
    autoAcceptHighConfidenceDuplicates: vi.fn(),
    acknowledgeAutoMerge: vi.fn(),
    keepAutoMergedClaimsSeparate: vi.fn()
  };
}

async function createCandidatesApp(
  service: CandidatesService,
  role: UserRole = 'candidate'
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(candidatesRoutes, {
    prefix: '/api/candidates',
    service,
    guards: createAuthGuards({
      repository: createAuthRepositoryDouble(role),
      jwtService: createJwtDouble(role)
    })
  });
  return app;
}

const authorization = { authorization: 'Bearer access-token' };

describe('candidates routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('requires authentication', async () => {
    app = await createCandidatesApp(createServiceDouble());

    const response = await app.inject({ method: 'GET', url: '/api/candidates/me' });

    expect(response.statusCode).toBe(401);
  });

  it('keeps an automatic merge separate with optimistic concurrency', async () => {
    const service = createServiceDouble();
    const restored = [claimRecord({ status: 'pending', version: 3 })];
    vi.mocked(service.keepAutoMergedClaimsSeparate).mockResolvedValue({
      claims: restored
    });
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/me/claims/${claimId}/keep-auto-merge-separate`,
      headers: { ...authorization, 'if-match': '"2"' },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { claims: [{ claimId, status: 'pending', version: 3 }] }
    });
    expect(service.keepAutoMergedClaimsSeparate).toHaveBeenCalledWith(
      userId,
      claimId,
      2
    );
  });

  it('allows only candidates to manage profiles', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service, 'reviewer');

    const response = await app.inject({
      method: 'GET',
      url: '/api/candidates/me/claims',
      headers: authorization
    });

    expect(response.statusCode).toBe(403);
    expect(service.listClaims).not.toHaveBeenCalled();
  });

  it('accepts only a valid contact email on the profile', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/candidates/me',
      headers: authorization,
      payload: { fullName: 'Example Candidate', contactEmail: 'not an email' }
    });
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/candidates/me',
      headers: authorization,
      payload: { contactEmail: null }
    });

    expect(invalid.statusCode).toBe(400);
    expect(service.createProfile).not.toHaveBeenCalled();
    expect(cleared.statusCode).toBe(200);
    expect(service.updateProfile).toHaveBeenCalledWith(
      userId,
      { contactEmail: null },
      undefined
    );
  });

  it('creates a claim for the authenticated user', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);
    const payload = {
      type: 'employment',
      values: {
        employer: 'Aramex',
        jobTitle: 'Backend Developer',
        startDate: '2021-03',
        skills: ['Node.js']
      }
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims',
      headers: authorization,
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(service.createClaim).toHaveBeenCalledWith(userId, payload);
  });

  it('accepts year-only claim dates without adding a month', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);
    const payload = {
      type: 'education',
      values: {
        institution: 'University of Jordan',
        degree: 'BSc',
        startDate: '2018',
        endDate: '2022'
      }
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims',
      headers: authorization,
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(service.createClaim).toHaveBeenCalledWith(userId, payload);
  });

  it('applies the values schema that matches the claim type', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);
    const invalidPayloads = [
      { type: 'employment', values: { employer: 'Aramex', startDate: '2021-03' } },
      {
        type: 'education',
        values: { institution: 'UJ', degree: 'BSc', startDate: '2021-13' }
      },
      { type: 'skill', values: { name: '   ' } },
      { type: 'language', values: { proficiency: 'Native' } },
      { type: 'language', values: { name: 'English', proficiency: '' } },
      { type: 'project', values: { description: 'A shop API' } },
      { type: 'project', values: { name: 'Shop API', url: 'not a link' } },
      { type: 'project', values: { name: 'Shop API', startDate: '2024-00' } },
      { type: 'award', values: { name: 'Best Graduate' } }
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/candidates/me/claims',
        headers: authorization,
        payload
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' }
      });
    }
    expect(service.createClaim).not.toHaveBeenCalled();
  });

  it('creates a language claim', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);
    const payload = { type: 'language', values: { name: 'English', proficiency: 'C1' } };

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims',
      headers: authorization,
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(service.createClaim).toHaveBeenCalledWith(userId, payload);
  });

  it('creates a project claim', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);
    const payload = {
      type: 'project',
      values: {
        name: 'Shop API',
        description: 'REST API for a shop app',
        role: 'Backend developer',
        url: 'https://github.com/example/shop',
        startDate: '2024-03',
        endDate: '2024-06',
        skills: ['Laravel', 'Docker']
      }
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims',
      headers: authorization,
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(service.createClaim).toHaveBeenCalledWith(userId, payload);
  });

  it('drops claim fields outside the claim type schema', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims',
      headers: authorization,
      payload: { type: 'skill', values: { name: 'Python', level: 'expert' } }
    });

    expect(response.statusCode).toBe(201);
    expect(service.createClaim).toHaveBeenCalledWith(userId, {
      type: 'skill',
      values: { name: 'Python' }
    });
  });

  it('validates claim identifiers', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/candidates/me/claims/not-a-uuid',
      headers: authorization
    });

    expect(response.statusCode).toBe(400);
    expect(service.deleteClaim).not.toHaveBeenCalled();
  });

  it('deletes a claim owned by the authenticated user', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/me/claims/${claimId}`,
      headers: authorization
    });

    expect(response.statusCode).toBe(204);
    expect(service.deleteClaim).toHaveBeenCalledWith(userId, claimId, undefined);
  });

  it('reviews a claim with optimistic versioning', async () => {
    const service = createServiceDouble();
    vi.mocked(service.reviewClaim).mockResolvedValue(extractedClaim('accepted', 2));
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/candidates/me/claims/${claimId}/review`,
      headers: { ...authorization, 'if-match': '"1"' },
      payload: { status: 'accepted' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(service.reviewClaim).toHaveBeenCalledWith(
      userId,
      claimId,
      { status: 'accepted' },
      1
    );
  });

  it('accepts only terminal review decisions', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/candidates/me/claims/${claimId}/review`,
      headers: authorization,
      payload: { status: 'pending' }
    });

    expect(response.statusCode).toBe(400);
    expect(service.reviewClaim).not.toHaveBeenCalled();
  });

  it('filters listed claims by type and status', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'GET',
      url: '/api/candidates/me/claims?type=skill&status=accepted',
      headers: authorization
    });

    expect(response.statusCode).toBe(200);
    expect(service.listClaims).toHaveBeenCalledWith(userId, {
      type: 'skill',
      status: 'accepted'
    });

    const languages = await app.inject({
      method: 'GET',
      url: '/api/candidates/me/claims?type=language',
      headers: authorization
    });

    expect(languages.statusCode).toBe(200);
    expect(service.listClaims).toHaveBeenCalledWith(userId, { type: 'language' });
  });

  it('returns a read-only merge proposal for two claim IDs', async () => {
    const service = createServiceDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(service.getClaimMergeProposal).mockResolvedValue({
      result: 'no_proposal',
      reason: 'different_identity'
    });
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'GET',
      url: `/api/candidates/me/claims/merge-proposal?leftClaimId=${claimId}&rightClaimId=${rightClaimId}`,
      headers: authorization
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { result: 'no_proposal', reason: 'different_identity' }
    });
    expect(service.getClaimMergeProposal).toHaveBeenCalledWith(
      userId,
      claimId,
      rightClaimId
    );
  });

  it('lists duplicate claim candidates without changing them', async () => {
    const service = createServiceDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(service.listClaimMergeCandidates).mockResolvedValue([
      {
        result: 'proposal',
        claimType: 'skill',
        identity: 'equivalent',
        left: { claimId, version: 2 },
        right: { claimId: rightClaimId, version: 4 },
        survivorClaimId: claimId,
        survivorReason: 'oldest_pending',
        fields: {
          name: { kind: 'same', value: 'TypeScript' }
        },
        proposedValues: { name: 'TypeScript' },
        unresolvedFields: [],
        requiresCandidateChoice: false,
        recommendedAction: 'automatic_coalesce'
      }
    ]);
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'GET',
      url: '/api/candidates/me/claims/merge-candidates',
      headers: authorization
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: [
        {
          result: 'proposal',
          left: { claimId },
          right: { claimId: rightClaimId }
        }
      ]
    });
    expect(service.listClaimMergeCandidates).toHaveBeenCalledWith(userId);
    expect(service.coalescePendingClaims).not.toHaveBeenCalled();
    expect(service.mergeConfirmedClaims).not.toHaveBeenCalled();
  });

  it('validates merge-proposal claim IDs', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'GET',
      url: `/api/candidates/me/claims/merge-proposal?leftClaimId=invalid&rightClaimId=${claimId}`,
      headers: authorization
    });

    expect(response.statusCode).toBe(400);
    expect(service.getClaimMergeProposal).not.toHaveBeenCalled();
  });

  it('coalesces a safe pair without accepting the pending survivor', async () => {
    const service = createServiceDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(service.coalescePendingClaims).mockResolvedValue({
      result: 'coalesced',
      survivor: extractedClaim('pending', 2),
      duplicate: {
        ...extractedClaim('pending', 2),
        claimId: rightClaimId,
        supersededByClaimId: claimId
      }
    });
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/coalesce',
      headers: authorization,
      payload: { leftClaimId: claimId, rightClaimId }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        result: 'coalesced',
        survivor: { status: 'pending' }
      }
    });
    expect(service.coalescePendingClaims).toHaveBeenCalledWith(
      userId,
      claimId,
      rightClaimId
    );
  });

  it('validates coalesce claim IDs', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/coalesce',
      headers: authorization,
      payload: { leftClaimId: claimId, rightClaimId: 'invalid' }
    });

    expect(response.statusCode).toBe(400);
    expect(service.coalescePendingClaims).not.toHaveBeenCalled();
  });

  it('records reviewed claims as different', async () => {
    const service = createServiceDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(service.recordClaimsDifferent).mockResolvedValue({
      result: 'recorded'
    });
    app = await createCandidatesApp(service);
    const payload = {
      leftClaimId: claimId,
      rightClaimId,
      leftVersion: 2,
      rightVersion: 4
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/different',
      headers: authorization,
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { result: 'recorded' }
    });
    expect(service.recordClaimsDifferent).toHaveBeenCalledWith(userId, payload);
  });

  it('validates different-decision claim IDs and versions', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/different',
      headers: authorization,
      payload: {
        leftClaimId: claimId,
        rightClaimId: 'invalid',
        leftVersion: 0,
        rightVersion: 1
      }
    });

    expect(response.statusCode).toBe(400);
    expect(service.recordClaimsDifferent).not.toHaveBeenCalled();
  });

  it('returns ordered per-item batch resolution outcomes', async () => {
    const service = createServiceDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(service.resolveClaimBatch).mockResolvedValue([
      {
        index: 0,
        action: 'accept_claim',
        status: 'accepted',
        claim: extractedClaim('accepted', 2)
      },
      {
        index: 1,
        action: 'merge_claims',
        status: 'conflict',
        current: []
      },
      {
        index: 2,
        action: 'merge_claim_group',
        status: 'accepted',
        survivor: claimRecord({ claimId: rightClaimId }),
        duplicates: [
          claimRecord({
            claimId: '66666666-6666-4666-8666-666666666666',
            supersededByClaimId: rightClaimId
          })
        ]
      }
    ]);
    app = await createCandidatesApp(service);
    const actions = [
      { action: 'accept_claim' as const, claimId, version: 1 },
      {
        action: 'merge_claims' as const,
        leftClaimId: rightClaimId,
        rightClaimId: '55555555-5555-4555-8555-555555555555',
        leftVersion: 2,
        rightVersion: 4,
        survivorClaimId: rightClaimId,
        values: { name: 'TypeScript' }
      },
      {
        action: 'merge_claim_group' as const,
        claims: [
          { claimId: rightClaimId, version: 2 },
          {
            claimId: '66666666-6666-4666-8666-666666666666',
            version: 1
          }
        ],
        survivorClaimId: rightClaimId,
        values: { name: 'TypeScript' }
      }
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/resolve-batch',
      headers: authorization,
      payload: { actions }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: [
        { index: 0, action: 'accept_claim', status: 'accepted' },
        { index: 1, action: 'merge_claims', status: 'conflict' },
        { index: 2, action: 'merge_claim_group', status: 'accepted' }
      ]
    });
    expect(service.resolveClaimBatch).toHaveBeenCalledWith(userId, actions);
  });

  it('validates batch size and action-specific fields', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/resolve-batch',
      headers: authorization,
      payload: { actions: [] }
    });
    const incomplete = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/resolve-batch',
      headers: authorization,
      payload: {
        actions: [{ action: 'accept_claim', claimId }]
      }
    });
    const incompleteGroup = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/resolve-batch',
      headers: authorization,
      payload: {
        actions: [
          {
            action: 'merge_claim_group',
            claims: [
              { claimId, version: 1 },
              {
                claimId: '44444444-4444-4444-8444-444444444444',
                version: 1
              }
            ],
            survivorClaimId: claimId
          }
        ]
      }
    });
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/resolve-batch',
      headers: authorization,
      payload: {
        actions: Array.from({ length: 101 }, (_, index) => ({
          action: 'accept_claim',
          claimId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          version: 1
        }))
      }
    });

    expect(empty.statusCode).toBe(400);
    expect(incomplete.statusCode).toBe(400);
    expect(incompleteGroup.statusCode).toBe(400);
    expect(tooLarge.statusCode).toBe(400);
    expect(service.resolveClaimBatch).not.toHaveBeenCalled();
  });

  it('returns a validation error before executing overlapping actions', async () => {
    const service = createServiceDouble();
    vi.mocked(service.resolveClaimBatch).mockRejectedValue(
      new OverlappingBatchClaimsError([claimId])
    );
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/resolve-batch',
      headers: authorization,
      payload: {
        actions: [
          { action: 'accept_claim', claimId, version: 1 },
          {
            action: 'merge_claims',
            leftClaimId: claimId,
            rightClaimId: '44444444-4444-4444-8444-444444444444',
            leftVersion: 1,
            rightVersion: 1,
            survivorClaimId: claimId,
            values: { name: 'TypeScript' }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'OVERLAPPING_BATCH_CLAIMS',
        details: { claimIds: [claimId] }
      }
    });
  });

  it('confirms a merge and accepts the survivor for export', async () => {
    const service = createServiceDouble();
    const rightClaimId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(service.mergeConfirmedClaims).mockResolvedValue({
      result: 'merged',
      survivor: extractedClaim('accepted', 3),
      duplicate: {
        ...extractedClaim('pending', 5),
        claimId: rightClaimId,
        supersededByClaimId: claimId
      }
    });
    app = await createCandidatesApp(service);
    const payload = {
      leftClaimId: claimId,
      rightClaimId,
      leftVersion: 2,
      rightVersion: 4,
      survivorClaimId: claimId,
      values: { name: 'TypeScript' }
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/merge',
      headers: authorization,
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        result: 'merged',
        survivor: { status: 'accepted' },
        duplicate: { supersededByClaimId: claimId }
      }
    });
    expect(service.mergeConfirmedClaims).toHaveBeenCalledWith(userId, payload);
  });

  it('validates confirmed merge IDs and reviewed versions', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'POST',
      url: '/api/candidates/me/claims/merge',
      headers: authorization,
      payload: {
        leftClaimId: claimId,
        rightClaimId: 'invalid',
        leftVersion: 0,
        rightVersion: 1,
        survivorClaimId: claimId,
        values: { name: 'TypeScript' }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(service.mergeConfirmedClaims).not.toHaveBeenCalled();
  });

  it('returns one owned claim with its entity tag', async () => {
    const service = createServiceDouble();
    app = await createCandidatesApp(service);

    const response = await app.inject({
      method: 'GET',
      url: `/api/candidates/me/claims/${claimId}`,
      headers: authorization
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"1"');
    expect(response.json()).toMatchObject({
      success: true,
      data: { claimId, version: 1 }
    });
    expect(service.getClaim).toHaveBeenCalledWith(userId, claimId);
  });

  describe('versions', () => {
    const claimUrl = `/api/candidates/me/claims/${claimId}`;
    const skill = { type: 'skill', values: { name: 'Go' } };

    it('returns the profile version as an entity tag', async () => {
      app = await createCandidatesApp(createServiceDouble());

      const response = await app.inject({
        method: 'GET',
        url: '/api/candidates/me',
        headers: authorization
      });

      expect(response.headers.etag).toBe('"4"');
      expect(response.json()).toMatchObject({ data: { version: 4 } });
    });

    it('passes If-Match to a claim edit and returns the new entity tag', async () => {
      const service = createServiceDouble();
      vi.mocked(service.updateClaim).mockResolvedValue(claimRecord({ version: 3 }));
      app = await createCandidatesApp(service);

      const response = await app.inject({
        method: 'PUT',
        url: claimUrl,
        headers: { ...authorization, 'if-match': '"2"' },
        payload: skill
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"3"');
      expect(service.updateClaim).toHaveBeenCalledWith(userId, claimId, skill, 2);
    });

    it('passes If-Match to profile edits and claim deletes', async () => {
      const service = createServiceDouble();
      app = await createCandidatesApp(service);

      await app.inject({
        method: 'PATCH',
        url: '/api/candidates/me',
        headers: { ...authorization, 'if-match': 'W/"4"' },
        payload: { headline: 'Engineer' }
      });
      await app.inject({
        method: 'DELETE',
        url: claimUrl,
        headers: { ...authorization, 'if-match': '5' }
      });

      expect(service.updateProfile).toHaveBeenCalledWith(
        userId,
        { headline: 'Engineer' },
        4
      );
      expect(service.deleteClaim).toHaveBeenCalledWith(userId, claimId, 5);
    });

    it('rejects an invalid If-Match without editing', async () => {
      const service = createServiceDouble();
      app = await createCandidatesApp(service);

      const response = await app.inject({
        method: 'PUT',
        url: claimUrl,
        headers: { ...authorization, 'if-match': 'latest' },
        payload: skill
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_IF_MATCH' } });
      expect(service.updateClaim).not.toHaveBeenCalled();
    });

    it('answers a version conflict with 409 and the current claim', async () => {
      const service = createServiceDouble();
      vi.mocked(service.updateClaim).mockRejectedValue(
        new VersionConflictError('Claim', claimRecord({ version: 3 }))
      );
      app = await createCandidatesApp(service);

      const response = await app.inject({
        method: 'PUT',
        url: claimUrl,
        headers: { ...authorization, 'if-match': '"2"' },
        payload: skill
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        success: false,
        error: {
          code: 'VERSION_CONFLICT',
          details: { current: { claimId, version: 3 } }
        }
      });
    });
  });
});
