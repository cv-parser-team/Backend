import { getTableConfig } from 'drizzle-orm/pg-core';
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandlerPlugin } from '../../infrastructure/http/error-handler.plugin.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { createAuthGuards } from '../auth/auth.guards.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { JwtService, UserRole } from '../auth/jwt-service.js';
import { UsersService } from '../users/users.service.js';
import {
  CandidateProfileExistsError,
  ClaimTypeMismatchError,
  InvalidClaimDatesError
} from './candidates.errors.js';
import {
  CandidateRecord,
  CandidatesRepository,
  ClaimRecord
} from './candidates.repository.js';
import { candidatesRoutes } from './candidates.routes.js';
import {
  CandidatesService,
  createCandidatesService
} from './candidates.service.js';
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
  createdAt: timestamp,
  updatedAt: timestamp
};

function claimRecord(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimId,
    claimType: 'skill',
    origin: 'manual',
    status: 'accepted',
    values: { name: 'Python' },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function createRepositoryDouble(
  candidate: CandidateRecord | null = candidateRecord
): CandidatesRepository {
  return {
    findCandidateByUserId: vi.fn().mockResolvedValue(candidate),
    createCandidate: vi.fn().mockResolvedValue(candidateRecord),
    updateCandidate: vi.fn().mockResolvedValue(candidateRecord),
    createClaim: vi.fn().mockResolvedValue(claimRecord()),
    listClaims: vi.fn().mockResolvedValue([]),
    findClaim: vi.fn().mockResolvedValue(claimRecord()),
    updateClaimValues: vi.fn().mockResolvedValue(claimRecord()),
    deleteClaim: vi.fn().mockResolvedValue(true)
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

function createService(repository: CandidatesRepository): CandidatesService {
  return createCandidatesService({
    repository,
    usersService: createUsersServiceDouble()
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
    expect(claimStatus.enumValues).toEqual(['pending', 'accepted', 'rejected']);
  });

  it('links profiles to users and claims to their owners', () => {
    expect(getTableConfig(candidates).foreignKeys).toHaveLength(1);
    expect(getTableConfig(claims).foreignKeys).toHaveLength(1);
    expect(getTableConfig(claimRevisions).foreignKeys).toHaveLength(1);
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
    expect(getTableConfig(employmentDetails).checks).toHaveLength(1);
    expect(getTableConfig(educationDetails).checks).toHaveLength(1);
    expect(getTableConfig(certificationDetails).checks).toHaveLength(1);
    expect(getTableConfig(projectDetails).checks).toHaveLength(1);
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

  it('requires a profile before managing claims', async () => {
    const service = createService(createRepositoryDouble(null));

    await expect(service.getProfile(userId)).rejects.toBeInstanceOf(
      RecordNotFoundError
    );
    await expect(
      service.createClaim(userId, { type: 'skill', values: { name: 'Python' } })
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('clears optional profile fields set to null', async () => {
    const repository = createRepositoryDouble();
    const service = createService(repository);

    await service.updateProfile(userId, {
      headline: null,
      summary: ' APIs ',
      contactEmail: null
    });

    expect(repository.updateCandidate).toHaveBeenCalledWith(candidateId, {
      headline: null,
      summary: 'APIs',
      contactEmail: null
    });
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
    vi.mocked(repository.deleteClaim).mockResolvedValue(false);
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
    expect(repository.deleteClaim).toHaveBeenCalledWith(candidateId, claimId);
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
    const service = createService(repository);

    const result = await service.exportProfile(userId);

    expect(repository.listClaims).toHaveBeenCalledWith(candidateId, {
      status: 'accepted'
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
    expect(result.skills).toEqual([{ claimId, name: 'Python', sources: [] }]);
    expect(Object.keys(result.skills[0] ?? {})[0]).toBe('claimId');
    expect(result.certifications).toHaveLength(1);
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
    verifyAccessToken: vi.fn().mockResolvedValue({ userId, role, tokenVersion: 0 })
  };
}

function createServiceDouble(): CandidatesService {
  return {
    createProfile: vi.fn(),
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    createClaim: vi.fn().mockResolvedValue(claimRecord()),
    listClaims: vi.fn().mockResolvedValue([claimRecord()]),
    updateClaim: vi.fn().mockResolvedValue(claimRecord()),
    deleteClaim: vi.fn().mockResolvedValue(undefined),
    exportProfile: vi.fn()
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
    expect(service.updateProfile).toHaveBeenCalledWith(userId, { contactEmail: null });
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
      { type: 'project', values: { name: 'Shop API', startDate: '2024' } },
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
    expect(service.deleteClaim).toHaveBeenCalledWith(userId, claimId);
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
});
