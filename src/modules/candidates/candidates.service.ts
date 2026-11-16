import { FastifyBaseLogger } from 'fastify';
import { UniqueConstraintViolationError } from '../../infrastructure/database/database.errors.js';
import { AppError, RecordNotFoundError } from '../../shared/errors/app.error.js';
import { UsersService } from '../users/users.service.js';
import {
  CandidateProfileExistsError,
  ClaimNotReviewableError,
  ClaimTypeMismatchError,
  OverlappingBatchClaimsError,
  VersionConflictError
} from './candidates.errors.js';
import {
  prepareClaimValues,
  prepareUnknownClaimValues
} from './candidates.claim-values.js';
import {
  type AutomaticCoalescePlanResult,
  buildAutomaticCoalescePlan,
  buildClaimMergeProposal,
  buildConfirmedClaimMergePlan,
  type ClaimMergeProposalResult,
  type ConfirmedClaimMergePlanResult,
  toMergeCandidateClaim
} from './candidates.claim-comparison.js';
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
  type ClaimBatchResolutionAction,
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

export type AutomaticClaimCoalesceResult =
  | Extract<AutomaticCoalescePlanResult, { result: 'no_merge' }>
  | Extract<AutomaticCoalescePlanResult, { result: 'candidate_review_required' }>
  | { result: 'coalesced'; survivor: ClaimRecord; duplicate: ClaimRecord };

export type ClaimMergeCandidate = Extract<
  ClaimMergeProposalResult,
  { result: 'proposal' }
>;

export interface ConfirmClaimMergeInput {
  leftClaimId: string;
  rightClaimId: string;
  leftVersion: number;
  rightVersion: number;
  survivorClaimId: string;
  values: unknown;
  current?: boolean;
}

export type ConfirmClaimMergeResult =
  | Extract<
      ConfirmedClaimMergePlanResult,
      { result: 'no_merge' | 'invalid_resolution' }
    >
  | { result: 'not_eligible' }
  | { result: 'merged'; survivor: ClaimRecord; duplicate: ClaimRecord };

type ClaimMergeNoProposalReason = Extract<
  ClaimMergeProposalResult,
  { result: 'no_proposal' }
>['reason'];

export interface RecordClaimsDifferentInput {
  leftClaimId: string;
  rightClaimId: string;
  leftVersion: number;
  rightVersion: number;
}

export type RecordClaimsDifferentResult =
  | { result: 'recorded' }
  | { result: 'no_decision'; reason: ClaimMergeNoProposalReason }
  | { result: 'not_eligible' };

type ClaimBatchActionName = ClaimBatchResolutionAction['action'];

export type ClaimBatchResolutionItemResult =
  | {
      index: number;
      action: 'accept_claim';
      status: 'accepted';
      claim: ClaimRecord;
    }
  | {
      index: number;
      action: 'merge_claims';
      status: 'accepted';
      survivor: ClaimRecord;
      duplicate: ClaimRecord;
    }
  | {
      index: number;
      action: ClaimBatchActionName;
      status: 'conflict';
      current: unknown;
    }
  | {
      index: number;
      action: ClaimBatchActionName;
      status: 'not_eligible';
      reason: string;
    }
  | {
      index: number;
      action: ClaimBatchActionName;
      status: 'failed';
      code: string;
      message: string;
    };

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
  getClaim(userId: string, claimId: string): Promise<ClaimRecord>;
  getClaimMergeProposal(
    userId: string,
    leftClaimId: string,
    rightClaimId: string
  ): Promise<ClaimMergeProposalResult>;
  listClaimMergeCandidates(userId: string): Promise<ClaimMergeCandidate[]>;
  recordClaimsDifferent(
    userId: string,
    input: RecordClaimsDifferentInput
  ): Promise<RecordClaimsDifferentResult>;
  coalescePendingClaims(
    userId: string,
    leftClaimId: string,
    rightClaimId: string
  ): Promise<AutomaticClaimCoalesceResult>;
  mergeConfirmedClaims(
    userId: string,
    input: ConfirmClaimMergeInput
  ): Promise<ConfirmClaimMergeResult>;
  resolveClaimBatch(
    userId: string,
    actions: ClaimBatchResolutionAction[]
  ): Promise<ClaimBatchResolutionItemResult[]>;
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

function hasSameValues(left: ClaimValues, right: ClaimValues): boolean {
  const fieldNames = Object.keys(left);
  return (
    fieldNames.length === Object.keys(right).length &&
    fieldNames.every(
      (fieldName) => JSON.stringify(left[fieldName]) === JSON.stringify(right[fieldName])
    )
  );
}

function claimPairVersionKey(
  leftClaimId: string,
  leftVersion: number,
  rightClaimId: string,
  rightVersion: number
): string {
  return `${leftClaimId}:${leftVersion}:${rightClaimId}:${rightVersion}`;
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

  const service: CandidatesService = {
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

      // Candidate-entered information needs no review and has no source document.
      const claim = await repository.createClaim({
        candidateId: candidate.candidateId,
        claimType: input.type,
        origin: 'manual',
        status: 'accepted',
        values: prepareClaimValues(input)
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

    async getClaim(userId, claimId) {
      const candidate = await requireCandidate(userId);
      return requireClaim(candidate.candidateId, claimId);
    },

    async getClaimMergeProposal(userId, leftClaimId, rightClaimId) {
      const candidate = await requireCandidate(userId);
      if (leftClaimId === rightClaimId) {
        return { result: 'no_proposal', reason: 'same_claim' };
      }

      const [left, right] = await Promise.all([
        requireClaim(candidate.candidateId, leftClaimId),
        requireClaim(candidate.candidateId, rightClaimId)
      ]);
      if (left.supersededByClaimId !== null || right.supersededByClaimId !== null) {
        return { result: 'no_proposal', reason: 'superseded_claim' };
      }

      const leftCandidate = toMergeCandidateClaim(candidate.candidateId, left);
      const rightCandidate = toMergeCandidateClaim(candidate.candidateId, right);
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_proposal', reason: 'rejected_claim' };
      }
      return buildClaimMergeProposal(leftCandidate, rightCandidate);
    },

    async listClaimMergeCandidates(userId) {
      const candidate = await requireCandidate(userId);
      const [claims, decisions] = await Promise.all([
        repository.listClaims(candidate.candidateId),
        repository.listClaimPairDecisions(candidate.candidateId)
      ]);
      const activeDecisionKeys = new Set(
        decisions.map((decision) =>
          claimPairVersionKey(
            decision.leftClaimId,
            decision.leftVersion,
            decision.rightClaimId,
            decision.rightVersion
          )
        )
      );
      const activeClaims = claims
        .filter(
          (claim) =>
            claim.status !== 'rejected' && claim.supersededByClaimId === null
        )
        .sort((left, right) => left.claimId.localeCompare(right.claimId))
        .map((claim) => toMergeCandidateClaim(candidate.candidateId, claim))
        .filter((claim) => claim !== null);
      const proposals: ClaimMergeCandidate[] = [];

      for (let leftIndex = 0; leftIndex < activeClaims.length; leftIndex += 1) {
        const left = activeClaims[leftIndex];
        if (!left) {
          continue;
        }
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < activeClaims.length;
          rightIndex += 1
        ) {
          const right = activeClaims[rightIndex];
          if (!right || left.claimType !== right.claimType) {
            continue;
          }
          if (
            activeDecisionKeys.has(
              claimPairVersionKey(
                left.claimId,
                left.version,
                right.claimId,
                right.version
              )
            )
          ) {
            continue;
          }
          const proposal = buildClaimMergeProposal(left, right);
          if (proposal.result === 'proposal') {
            proposals.push(proposal);
          }
        }
      }

      return proposals;
    },

    async recordClaimsDifferent(userId, input) {
      const candidate = await requireCandidate(userId);
      if (input.leftClaimId === input.rightClaimId) {
        return { result: 'no_decision', reason: 'same_claim' };
      }

      const [left, right] = await Promise.all([
        requireClaim(candidate.candidateId, input.leftClaimId),
        requireClaim(candidate.candidateId, input.rightClaimId)
      ]);
      if (
        left.version !== input.leftVersion ||
        right.version !== input.rightVersion
      ) {
        throw new VersionConflictError('Claims', [left, right]);
      }
      if (left.supersededByClaimId !== null || right.supersededByClaimId !== null) {
        return { result: 'no_decision', reason: 'superseded_claim' };
      }

      const leftCandidate = toMergeCandidateClaim(candidate.candidateId, left);
      const rightCandidate = toMergeCandidateClaim(candidate.candidateId, right);
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_decision', reason: 'rejected_claim' };
      }
      const proposal = buildClaimMergeProposal(leftCandidate, rightCandidate);
      if (proposal.result === 'no_proposal') {
        return { result: 'no_decision', reason: proposal.reason };
      }

      const result = await repository.recordClaimsDifferent({
        candidateId: candidate.candidateId,
        left: {
          claimId: input.leftClaimId,
          expectedVersion: input.leftVersion
        },
        right: {
          claimId: input.rightClaimId,
          expectedVersion: input.rightVersion
        }
      });
      switch (result.status) {
        case 'saved':
          return { result: 'recorded' };
        case 'conflict':
          throw new VersionConflictError('Claims', result.current);
        case 'not_eligible':
          return { result: 'not_eligible' };
        case 'missing':
          throw new RecordNotFoundError('Claim pair');
      }
    },

    async coalescePendingClaims(userId, leftClaimId, rightClaimId) {
      const candidate = await requireCandidate(userId);
      if (leftClaimId === rightClaimId) {
        return { result: 'no_merge', reason: 'same_claim' };
      }

      const [left, right] = await Promise.all([
        requireClaim(candidate.candidateId, leftClaimId),
        requireClaim(candidate.candidateId, rightClaimId)
      ]);
      if (left.supersededByClaimId !== null || right.supersededByClaimId !== null) {
        return { result: 'no_merge', reason: 'superseded_claim' };
      }
      const leftCandidate = toMergeCandidateClaim(candidate.candidateId, left);
      const rightCandidate = toMergeCandidateClaim(candidate.candidateId, right);
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_merge', reason: 'rejected_claim' };
      }

      const plan = buildAutomaticCoalescePlan(leftCandidate, rightCandidate);
      if (plan.result !== 'ready') {
        return plan;
      }
      const result = await repository.coalescePendingClaims({
        candidateId: candidate.candidateId,
        survivor: plan.survivor,
        duplicate: plan.duplicate,
        values: plan.values,
        ...(plan.current !== undefined ? { current: plan.current } : {})
      });
      switch (result.status) {
        case 'saved':
          return {
            result: 'coalesced',
            survivor: result.survivor,
            duplicate: result.duplicate
          };
        case 'conflict':
          throw new VersionConflictError('Claims', result.current);
        case 'not_eligible':
          return { result: 'candidate_review_required' };
        case 'missing':
          throw new RecordNotFoundError('Claim pair');
      }
    },

    async mergeConfirmedClaims(userId, input) {
      const candidate = await requireCandidate(userId);
      if (input.leftClaimId === input.rightClaimId) {
        return { result: 'no_merge', reason: 'same_claim' };
      }

      const [left, right] = await Promise.all([
        requireClaim(candidate.candidateId, input.leftClaimId),
        requireClaim(candidate.candidateId, input.rightClaimId)
      ]);
      if (left.supersededByClaimId !== null || right.supersededByClaimId !== null) {
        return { result: 'no_merge', reason: 'superseded_claim' };
      }
      if (left.status === 'rejected' || right.status === 'rejected') {
        return { result: 'no_merge', reason: 'rejected_claim' };
      }
      if (left.claimType !== right.claimType) {
        return { result: 'no_merge', reason: 'different_type' };
      }

      const values = prepareUnknownClaimValues(left.claimType, input.values);
      const leftCandidate = toMergeCandidateClaim(candidate.candidateId, left);
      const rightCandidate = toMergeCandidateClaim(candidate.candidateId, right);
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_merge', reason: 'rejected_claim' };
      }
      const plan = buildConfirmedClaimMergePlan(leftCandidate, rightCandidate, {
        leftVersion: input.leftVersion,
        rightVersion: input.rightVersion,
        survivorClaimId: input.survivorClaimId,
        values,
        ...(input.current !== undefined ? { current: input.current } : {})
      });
      if (plan.result === 'version_conflict') {
        throw new VersionConflictError('Claims', [left, right]);
      }
      if (plan.result !== 'ready') {
        return plan;
      }

      const result = await repository.mergeConfirmedClaims({
        candidateId: candidate.candidateId,
        survivor: plan.survivor,
        duplicate: plan.duplicate,
        values: plan.values,
        ...(plan.current !== undefined ? { current: plan.current } : {})
      });
      switch (result.status) {
        case 'saved':
          await normalize(result.survivor);
          return {
            result: 'merged',
            survivor: result.survivor,
            duplicate: result.duplicate
          };
        case 'conflict':
          throw new VersionConflictError('Claims', result.current);
        case 'not_eligible':
          return { result: 'not_eligible' };
        case 'missing':
          throw new RecordNotFoundError('Claim pair');
      }
    },

    async resolveClaimBatch(userId, actions) {
      const seenClaimIds = new Set<string>();
      const overlappingClaimIds = new Set<string>();
      for (const action of actions) {
        const claimIds =
          action.action === 'accept_claim'
            ? [action.claimId]
            : [action.leftClaimId, action.rightClaimId];
        for (const claimId of claimIds) {
          if (seenClaimIds.has(claimId)) {
            overlappingClaimIds.add(claimId);
          }
          seenClaimIds.add(claimId);
        }
      }
      if (overlappingClaimIds.size > 0) {
        throw new OverlappingBatchClaimsError([...overlappingClaimIds].sort());
      }

      async function executeAction(
        action: ClaimBatchResolutionAction,
        index: number
      ): Promise<ClaimBatchResolutionItemResult> {
        try {
          if (action.action === 'accept_claim') {
            const claim = await service.reviewClaim(
              userId,
              action.claimId,
              { status: 'accepted' },
              action.version
            );
            return {
              index,
              action: action.action,
              status: 'accepted',
              claim
            };
          }

          const result = await service.mergeConfirmedClaims(userId, action);
          if (result.result === 'merged') {
            return {
              index,
              action: action.action,
              status: 'accepted',
              survivor: result.survivor,
              duplicate: result.duplicate
            };
          }
          return {
            index,
            action: action.action,
            status: 'not_eligible',
            reason:
              'reason' in result
                ? `${result.result}:${result.reason}`
                : result.result
          };
        } catch (error) {
          if (error instanceof VersionConflictError) {
            const details = error.details;
            const current =
              typeof details === 'object' &&
              details !== null &&
              'current' in details
                ? details.current
                : undefined;
            return {
              index,
              action: action.action,
              status: 'conflict',
              current
            };
          }
          if (error instanceof ClaimNotReviewableError) {
            return {
              index,
              action: action.action,
              status: 'not_eligible',
              reason: error.code
            };
          }
          if (error instanceof AppError) {
            return {
              index,
              action: action.action,
              status: 'failed',
              code: error.code,
              message: error.message
            };
          }

          logger.warn({ err: error, index }, 'Claim batch action failed');
          return {
            index,
            action: action.action,
            status: 'failed',
            code: 'INTERNAL_ERROR',
            message: 'Claim batch action failed'
          };
        }
      }

      const results: ClaimBatchResolutionItemResult[] = [];
      const concurrency = 5;
      for (let offset = 0; offset < actions.length; offset += concurrency) {
        const chunk = actions.slice(offset, offset + concurrency);
        results.push(
          ...(await Promise.all(
            chunk.map((action, chunkIndex) =>
              executeAction(action, offset + chunkIndex)
            )
          ))
        );
      }
      return results;
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
      const values = prepareClaimValues(input);
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

  return service;
}
