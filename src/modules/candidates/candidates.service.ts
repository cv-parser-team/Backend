import { FastifyBaseLogger } from 'fastify';
import { UniqueConstraintViolationError } from '../../infrastructure/database/database.errors.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { UsersService } from '../users/users.service.js';
import {
  CandidateProfileExistsError,
  ClaimNotReviewableError,
  ClaimTypeMismatchError,
  InvalidClaimDatesError,
  VersionConflictError
} from './candidates.errors.js';
import {
  CandidateRecord,
  CandidatesRepository,
  ClaimRecord,
  ClaimSourceOccurrenceRecord,
  ClaimValues,
  UpdateCandidateInput
} from './candidates.repository.js';
import {
  ClaimBody,
  CreateCandidateBody,
  ListClaimsQuery,
  ReviewClaimBody,
  UpdateCandidateBody
} from './candidates.schemas.js';
import { ClaimSourceAnchor, ProfileLink } from './candidates.table.js';

export interface CandidateProfile {
  candidateId: string;
  fullName: string;
  email: string;
  headline: string | null;
  summary: string | null;
  phone: string | null;
  location: string | null;
  contactEmail: string | null;
  profileLinks: ProfileLink[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimSourceReference {
  documentId: string;
  references: string[];
  fields: string[];
  anchor: ClaimSourceAnchor;
}

export type ExportedClaim = Record<
  string,
  ClaimValues[string] | ClaimSourceReference[]
> & {
  claimId: string;
  sources: ClaimSourceReference[];
};

export interface ExportedProfile {
  personalInfo: Omit<
    CandidateProfile,
    'candidateId' | 'version' | 'createdAt' | 'updatedAt'
  >;
  skills: ExportedClaim[];
  employment: ExportedClaim[];
  education: ExportedClaim[];
  certifications: ExportedClaim[];
  languages: ExportedClaim[];
  projects: ExportedClaim[];
}

export interface CandidatesService {
  createProfile(userId: string, input: CreateCandidateBody): Promise<CandidateProfile>;
  getProfile(userId: string): Promise<CandidateProfile>;
  // `expectedVersion` is the version the client last read; when given, a
  // record that changed since is refused with VersionConflictError.
  updateProfile(
    userId: string,
    input: UpdateCandidateBody,
    expectedVersion?: number
  ): Promise<CandidateProfile>;
  createClaim(userId: string, input: ClaimBody): Promise<ClaimRecord>;
  listClaims(userId: string, query: ListClaimsQuery): Promise<ClaimRecord[]>;
  updateClaim(
    userId: string,
    claimId: string,
    input: ClaimBody,
    expectedVersion?: number
  ): Promise<ClaimRecord>;
  reviewClaim(
    userId: string,
    claimId: string,
    input: ReviewClaimBody,
    expectedVersion?: number
  ): Promise<ClaimRecord>;
  deleteClaim(userId: string, claimId: string, expectedVersion?: number): Promise<void>;
  exportProfile(userId: string): Promise<ExportedProfile>;
}

// Links claim values to canonical terms. Implemented by the normalization
// module; only this call is needed here.
export interface ClaimNormalizer {
  normalizeClaim(claim: ClaimRecord): Promise<unknown>;
}

export interface CandidatesServiceDependencies {
  repository: CandidatesRepository;
  usersService: Pick<UsersService, 'getUserById'>;
  normalizer: ClaimNormalizer;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

function trimOptional(value: string | null | undefined): string | null {
  return value?.trim() ?? null;
}

function normalizeProfileLinks(links: ProfileLink[]): ProfileLink[] {
  return links.map((link) => ({ label: link.label.trim(), url: link.url.trim() }));
}

function toCandidateProfile(
  candidate: CandidateRecord,
  email: string
): CandidateProfile {
  return {
    candidateId: candidate.candidateId,
    fullName: candidate.fullName,
    email,
    headline: candidate.headline,
    summary: candidate.summary,
    phone: candidate.phone,
    location: candidate.location,
    contactEmail: candidate.contactEmail,
    profileLinks: candidate.profileLinks,
    version: candidate.version,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  };
}

function normalizeClaimValues(values: ClaimBody['values']): ClaimValues {
  const normalized: ClaimValues = {};

  for (const [fieldName, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      normalized[fieldName] = value.trim();
    } else if (Array.isArray(value) && value.length > 0) {
      normalized[fieldName] = [...new Set(value.map((item) => item.trim()))];
    }
  }

  return normalized;
}

// YYYY-MM strings sort chronologically, so plain comparison is sufficient.
function assertValidClaimDates(input: ClaimBody): void {
  switch (input.type) {
    case 'employment':
    case 'education':
      if (input.values.endDate && input.values.endDate < input.values.startDate) {
        throw new InvalidClaimDatesError('End date cannot be before start date');
      }
      break;
    case 'certification':
      if (
        input.values.expiryDate &&
        input.values.expiryDate < input.values.issueDate
      ) {
        throw new InvalidClaimDatesError('Expiry date cannot be before issue date');
      }
      break;
    case 'project':
      if (
        input.values.startDate &&
        input.values.endDate &&
        input.values.endDate < input.values.startDate
      ) {
        throw new InvalidClaimDatesError('End date cannot be before start date');
      }
      break;
    case 'skill':
    case 'language':
      break;
  }
}

function hasSameValues(left: ClaimValues, right: ClaimValues): boolean {
  const fieldNames = Object.keys(left);
  return (
    fieldNames.length === Object.keys(right).length &&
    fieldNames.every(
      (fieldName) => JSON.stringify(left[fieldName]) === JSON.stringify(right[fieldName])
    )
  );
}

function toSourceReference(
  occurrence: ClaimSourceOccurrenceRecord
): ClaimSourceReference {
  return {
    documentId: occurrence.documentId,
    references: occurrence.sourceReferences,
    fields: occurrence.fieldNames,
    anchor: occurrence.anchor
  };
}

function toExportedClaim(
  claim: ClaimRecord,
  sources: ClaimSourceReference[]
): ExportedClaim {
  return { claimId: claim.claimId, ...claim.values, sources };
}

export function createCandidatesService({
  repository,
  usersService,
  normalizer,
  logger
}: CandidatesServiceDependencies): CandidatesService {
  // The claim is already saved. If normalization fails, the claim stays
  // without a decision and is treated as unmatched; it can be normalized again.
  async function normalize(claim: ClaimRecord): Promise<void> {
    try {
      await normalizer.normalizeClaim(claim);
    } catch (error) {
      logger.warn({ err: error, claimId: claim.claimId }, 'Claim normalization failed');
    }
  }

  async function requireCandidate(userId: string): Promise<CandidateRecord> {
    const candidate = await repository.findCandidateByUserId(userId);
    if (!candidate) {
      throw new RecordNotFoundError('Candidate profile');
    }
    return candidate;
  }

  async function getEmail(userId: string): Promise<string> {
    const user = await usersService.getUserById(userId);
    return user.email;
  }

  async function requireClaim(
    candidateId: string,
    claimId: string
  ): Promise<ClaimRecord> {
    const claim = await repository.findClaim(candidateId, claimId);
    if (!claim) {
      throw new RecordNotFoundError('Claim', claimId);
    }
    return claim;
  }

  return {
    async createProfile(userId, input) {
      const existing = await repository.findCandidateByUserId(userId);
      if (existing) {
        throw new CandidateProfileExistsError();
      }

      let candidate: CandidateRecord;
      try {
        candidate = await repository.createCandidate({
          userId,
          fullName: input.fullName.trim(),
          headline: trimOptional(input.headline),
          summary: trimOptional(input.summary),
          phone: trimOptional(input.phone),
          location: trimOptional(input.location),
          contactEmail: trimOptional(input.contactEmail),
          profileLinks: normalizeProfileLinks(input.profileLinks ?? [])
        });
      } catch (error) {
        // A concurrent request created the profile after the check above; the
        // unique user index refused this one. Both requests get the same error.
        if (error instanceof UniqueConstraintViolationError) {
          throw new CandidateProfileExistsError();
        }
        throw error;
      }

      return toCandidateProfile(candidate, await getEmail(userId));
    },

    async getProfile(userId) {
      const candidate = await requireCandidate(userId);
      return toCandidateProfile(candidate, await getEmail(userId));
    },

    async updateProfile(userId, input, expectedVersion) {
      const candidate = await requireCandidate(userId);
      const changes: UpdateCandidateInput = {};

      if (input.fullName !== undefined) {
        changes.fullName = input.fullName.trim();
      }
      if (input.headline !== undefined) {
        changes.headline = trimOptional(input.headline);
      }
      if (input.summary !== undefined) {
        changes.summary = trimOptional(input.summary);
      }
      if (input.phone !== undefined) {
        changes.phone = trimOptional(input.phone);
      }
      if (input.location !== undefined) {
        changes.location = trimOptional(input.location);
      }
      if (input.contactEmail !== undefined) {
        changes.contactEmail = trimOptional(input.contactEmail);
      }
      if (input.profileLinks !== undefined) {
        changes.profileLinks = normalizeProfileLinks(input.profileLinks);
      }

      const result = await repository.updateCandidate(
        candidate.candidateId,
        changes,
        expectedVersion
      );
      const email = await getEmail(userId);
      switch (result.status) {
        case 'saved':
          return toCandidateProfile(result.record, email);
        case 'conflict':
          throw new VersionConflictError(
            'Candidate profile',
            toCandidateProfile(result.current, email)
          );
        case 'missing':
          throw new RecordNotFoundError('Candidate profile');
      }
    },

    async createClaim(userId, input) {
      const candidate = await requireCandidate(userId);
      assertValidClaimDates(input);

      // Candidate-entered information needs no review and has no source document.
      const claim = await repository.createClaim({
        candidateId: candidate.candidateId,
        claimType: input.type,
        origin: 'manual',
        status: 'accepted',
        values: normalizeClaimValues(input.values)
      });
      await normalize(claim);
      return claim;
    },

    async listClaims(userId, query) {
      const candidate = await requireCandidate(userId);
      return repository.listClaims(candidate.candidateId, {
        claimType: query.type,
        status: query.status
      });
    },

    async updateClaim(userId, claimId, input, expectedVersion) {
      const candidate = await requireCandidate(userId);
      const claim = await requireClaim(candidate.candidateId, claimId);

      // Checked first: the client decided on values it read from an older
      // version, even when its values happen to equal the current ones.
      if (expectedVersion !== undefined && claim.version !== expectedVersion) {
        throw new VersionConflictError('Claim', claim);
      }
      if (claim.claimType !== input.type) {
        throw new ClaimTypeMismatchError();
      }
      assertValidClaimDates(input);

      const values = normalizeClaimValues(input.values);
      if (hasSameValues(claim.values, values)) {
        return claim;
      }

      const result = await repository.updateClaimValues({
        candidateId: candidate.candidateId,
        claimId,
        values,
        expectedVersion
      });
      switch (result.status) {
        case 'saved':
          await normalize(result.record);
          return result.record;
        case 'conflict':
          throw new VersionConflictError('Claim', result.current);
        case 'missing':
          throw new RecordNotFoundError('Claim', claimId);
      }
    },

    async deleteClaim(userId, claimId, expectedVersion) {
      const candidate = await requireCandidate(userId);
      const result = await repository.deleteClaim(
        candidate.candidateId,
        claimId,
        expectedVersion
      );
      switch (result.status) {
        case 'deleted':
          return;
        case 'conflict':
          throw new VersionConflictError('Claim', result.current);
        case 'missing':
          throw new RecordNotFoundError('Claim', claimId);
      }
    },

    async reviewClaim(userId, claimId, input, expectedVersion) {
      const candidate = await requireCandidate(userId);
      const result = await repository.reviewExtractedClaim(
        candidate.candidateId,
        claimId,
        input.status,
        expectedVersion
      );
      switch (result.status) {
        case 'saved':
          if (result.record.status === 'accepted') {
            await normalize(result.record);
          }
          return result.record;
        case 'conflict':
          throw new VersionConflictError('Claim', result.current);
        case 'not_reviewable':
          throw new ClaimNotReviewableError(result.current);
        case 'missing':
          throw new RecordNotFoundError('Claim', claimId);
      }
    },

    async exportProfile(userId) {
      const candidate = await requireCandidate(userId);
      const [email, acceptedClaims] = await Promise.all([
        getEmail(userId),
        repository.listClaims(candidate.candidateId, { status: 'accepted' })
      ]);
      const occurrences = await repository.listClaimSourceOccurrences(
        candidate.candidateId,
        acceptedClaims.map(({ claimId }) => claimId)
      );
      const sourcesByClaim = new Map<string, ClaimSourceReference[]>();
      for (const occurrence of occurrences) {
        const sources = sourcesByClaim.get(occurrence.claimId) ?? [];
        sources.push(toSourceReference(occurrence));
        sourcesByClaim.set(occurrence.claimId, sources);
      }

      const exported: ExportedProfile = {
        personalInfo: {
          fullName: candidate.fullName,
          email,
          contactEmail: candidate.contactEmail,
          headline: candidate.headline,
          summary: candidate.summary,
          phone: candidate.phone,
          location: candidate.location,
          profileLinks: candidate.profileLinks
        },
        skills: [],
        employment: [],
        education: [],
        certifications: [],
        languages: [],
        projects: []
      };

      for (const claim of acceptedClaims) {
        const exportedClaim = toExportedClaim(
          claim,
          sourcesByClaim.get(claim.claimId) ?? []
        );
        switch (claim.claimType) {
          case 'skill':
            exported.skills.push(exportedClaim);
            break;
          case 'employment':
            exported.employment.push(exportedClaim);
            break;
          case 'education':
            exported.education.push(exportedClaim);
            break;
          case 'certification':
            exported.certifications.push(exportedClaim);
            break;
          case 'language':
            exported.languages.push(exportedClaim);
            break;
          case 'project':
            exported.projects.push(exportedClaim);
            break;
        }
      }

      return exported;
    }
  };
}
