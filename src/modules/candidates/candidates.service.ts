import { FastifyBaseLogger } from 'fastify';
import { UniqueConstraintViolationError } from '../../infrastructure/database/database.errors.js';
import { AppError, RecordNotFoundError } from '../../shared/errors/app.error.js';
import { UsersService } from '../users/users.service.js';
import {
  AutoMergeCannotBeRevertedError,
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
  buildAutoAcceptMergePlan,
  buildClaimMergeProposal,
  buildConfirmedClaimMergePlan,
  type ClaimMergeProposalResult,
  type ConfirmedClaimMergePlanResult,
  type MergeCandidateClaim,
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
import { ClaimAutoMergeNoticeRecord, ClaimSourceAnchor, ProfileLink } from './candidates.table.js';
import {
  type DuplicateJudge,
  haveCloseDateRanges
} from './candidates.duplicate-ai.js';

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

export type AutoAcceptMergeResult =
  | { result: 'no_merge'; reason: string }
  | { result: 'candidate_review_required' }
  | {
      result: 'auto_accepted';
      survivor: ClaimRecord;
      duplicate: ClaimRecord;
      noticeId: string;
    };

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

export interface ConfirmClaimGroupMergeInput {
  claims: Array<{ claimId: string; version: number }>;
  survivorClaimId: string;
  values: unknown;
  current?: boolean;
}

export type ConfirmClaimGroupMergeResult =
  | { result: 'not_eligible'; reason: string }
  | { result: 'merged'; survivor: ClaimRecord; duplicates: ClaimRecord[] };

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
      action: 'merge_claim_group';
      status: 'accepted';
      survivor: ClaimRecord;
      duplicates: ClaimRecord[];
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
  listClaims(userId: string, query: ListClaimsQuery): Promise<ListedClaim[]>;
  getClaim(userId: string, claimId: string): Promise<ListedClaim>;
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
  autoAcceptMergeClaims(
    userId: string,
    leftClaimId: string,
    rightClaimId: string
  ): Promise<AutoAcceptMergeResult>;
  // After a successful extraction save, safely auto-accepts high-confidence
  // duplicate pairs across the candidate's active claims.
  autoAcceptHighConfidenceDuplicates(userId: string): Promise<{
    applied: number;
    skipped: number;
  }>;
  acknowledgeAutoMerge(
    userId: string,
    claimId: string,
    expectedVersion?: number
  ): Promise<{
    status: ClaimRecord['status'];
    acknowledged: number;
  }>;
  keepAutoMergedClaimsSeparate(
    userId: string,
    claimId: string,
    expectedVersion?: number
  ): Promise<{ claims: ClaimRecord[] }>;
  mergeConfirmedClaims(
    userId: string,
    input: ConfirmClaimMergeInput
  ): Promise<ConfirmClaimMergeResult>;
  mergeConfirmedClaimGroup(
    userId: string,
    input: ConfirmClaimGroupMergeInput
  ): Promise<ConfirmClaimGroupMergeResult>;
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
// How a claim's normalized value is shown: the canonical name of its term,
// with the value the candidate's document or edit wrote.
export interface NormalizedClaimValue {
  value: string;
  original: string;
  method: string;
  confidence: number | null;
}

// A claim as listed to its candidate: its own values, plus the canonical name
// its normalized field is shown as when that differs. Values never change.
export type ListedClaim = ClaimRecord & {
  normalized?: Record<string, NormalizedClaimValue>;
  openMergeNotices?: ClaimAutoMergeNoticeRecord[];
};

export interface ClaimNormalizer {
  normalizeClaim(claim: ClaimRecord): Promise<unknown>;
  describeNormalizedValues(
    claims: ClaimRecord[]
  ): Promise<Map<string, Record<string, NormalizedClaimValue>>>;
  // The canonical term linked to each claim's normalized field, by claim ID
  // and field, so duplicate detection can compare values by meaning.
  findNormalizedTerms(claims: ClaimRecord[]): Promise<Map<string, Record<string, string>>>;
}

export interface CandidatesServiceDependencies {
  repository: CandidatesRepository;
  usersService: Pick<UsersService, 'getUserById'>;
  normalizer: ClaimNormalizer;
  logger: Pick<FastifyBaseLogger, 'warn'>;
  duplicateJudge?: DuplicateJudge;
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
  logger,
  duplicateJudge
}: CandidatesServiceDependencies): CandidatesService {
  const duplicateJudgmentCache = new Map<string, Promise<boolean>>();

  async function aiAllowsCloseDateProposal(
    left: MergeCandidateClaim,
    right: MergeCandidateClaim,
    proposal: ClaimMergeProposalResult
  ): Promise<boolean> {
    if (
      proposal.result !== 'proposal' ||
      proposal.identity !== 'suspected_duplicate' ||
      !duplicateJudge ||
      !haveCloseDateRanges(left, right)
    ) {
      return proposal.result === 'proposal';
    }

    const key = claimPairVersionKey(
      left.claimId,
      left.version,
      right.claimId,
      right.version
    );
    let judgment = duplicateJudgmentCache.get(key);
    if (!judgment) {
      judgment = duplicateJudge
        .judge(left, right)
        .then((result) => result.status !== 'different')
        .catch((error: unknown) => {
          logger.warn(
            { err: error, leftClaimId: left.claimId, rightClaimId: right.claimId },
            'AI duplicate judgment failed; retaining candidate review'
          );
          return true;
        });
      duplicateJudgmentCache.set(key, judgment);
    }
    return judgment;
  }
  // The claim is already saved. If normalization fails, the claim stays
  // without a decision and is treated as unmatched; it can be normalized again.
  async function normalize(claim: ClaimRecord): Promise<void> {
    try {
      await normalizer.normalizeClaim(claim);
    } catch (error) {
      logger.warn({ err: error, claimId: claim.claimId }, 'Claim normalization failed');
    }
  }

  // Every comparison of the same claims must see the same terms, or a merge
  // listed as a proposal could be refused when it is confirmed. Without terms,
  // claims are still compared by their written values.
  async function toMergeCandidates(
    candidateId: string,
    claims: ClaimRecord[]
  ): Promise<(MergeCandidateClaim | null)[]> {
    let terms = new Map<string, Record<string, string>>();
    try {
      terms = await normalizer.findNormalizedTerms(claims);
    } catch (error) {
      logger.warn({ err: error }, 'Normalized terms could not be loaded for comparison');
    }
    return claims.map((claim) =>
      toMergeCandidateClaim(candidateId, claim, terms.get(claim.claimId))
    );
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
      const claims = await repository.listClaims(candidate.candidateId, {
        claimType: query.type,
        status: query.status
      });
      // Canonical names only improve how values are shown; the list is still
      // returned with the values as written when they cannot be loaded.
      let described = new Map<string, Record<string, NormalizedClaimValue>>();
      try {
        described = await normalizer.describeNormalizedValues(claims);
      } catch (error) {
        logger.warn({ err: error }, 'Normalized values could not be loaded');
      }
      let openNoticesByClaim = new Map<string, ClaimAutoMergeNoticeRecord[]>();
      try {
        const notices = await repository.listOpenAutoMergeNotices(
          candidate.candidateId,
          claims.map((claim) => claim.claimId)
        );
        for (const notice of notices) {
          const list = openNoticesByClaim.get(notice.survivorClaimId) ?? [];
          list.push(notice);
          openNoticesByClaim.set(notice.survivorClaimId, list);
        }
      } catch (error) {
        logger.warn({ err: error }, 'Open auto-merge notices could not be loaded');
      }
      return claims.map((claim) => {
        const normalized = described.get(claim.claimId);
        const openMergeNotices = openNoticesByClaim.get(claim.claimId);
        return {
          ...claim,
          ...(normalized ? { normalized } : {}),
          ...(openMergeNotices && openMergeNotices.length > 0
            ? { openMergeNotices }
            : {})
        };
      });
    },

    async getClaim(userId, claimId) {
      const candidate = await requireCandidate(userId);
      const claim = await requireClaim(candidate.candidateId, claimId);
      let openMergeNotices: ClaimAutoMergeNoticeRecord[] | undefined;
      try {
        const notices = await repository.listOpenAutoMergeNotices(
          candidate.candidateId,
          [claimId]
        );
        if (notices.length > 0) {
          openMergeNotices = notices;
        }
      } catch (error) {
        logger.warn({ err: error, claimId }, 'Open auto-merge notices could not be loaded');
      }
      return {
        ...claim,
        ...(openMergeNotices ? { openMergeNotices } : {})
      };
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

      const [leftCandidate, rightCandidate] = await toMergeCandidates(
        candidate.candidateId,
        [left, right]
      );
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_proposal', reason: 'rejected_claim' };
      }
      const proposal = buildClaimMergeProposal(leftCandidate, rightCandidate);
      return (await aiAllowsCloseDateProposal(leftCandidate, rightCandidate, proposal))
        ? proposal
        : { result: 'no_proposal', reason: 'different_identity' };
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
      const activeClaims = (
        await toMergeCandidates(
          candidate.candidateId,
          claims
            .filter(
              (claim) =>
                claim.status !== 'rejected' && claim.supersededByClaimId === null
            )
            .sort((left, right) => left.claimId.localeCompare(right.claimId))
        )
      ).filter((claim) => claim !== null);
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
          if (
            proposal.result === 'proposal' &&
            (await aiAllowsCloseDateProposal(left, right, proposal))
          ) {
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

      const [leftCandidate, rightCandidate] = await toMergeCandidates(
        candidate.candidateId,
        [left, right]
      );
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
      const [leftCandidate, rightCandidate] = await toMergeCandidates(
        candidate.candidateId,
        [left, right]
      );
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_merge', reason: 'rejected_claim' };
      }

      const plan = buildAutomaticCoalescePlan(leftCandidate, rightCandidate);
      if (plan.result !== 'ready') {
        return plan as AutomaticClaimCoalesceResult;
      }
      const result = await repository.coalescePendingClaims({
        candidateId: candidate.candidateId,
        survivor: plan.survivor,
        duplicate: plan.duplicate,
        values: plan.values,
        ...(plan.current !== undefined ? { current: plan.current } : {}),
        messages: plan.messages
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

    async autoAcceptMergeClaims(userId, leftClaimId, rightClaimId) {
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
      const [leftCandidate, rightCandidate] = await toMergeCandidates(
        candidate.candidateId,
        [left, right]
      );
      if (!leftCandidate || !rightCandidate) {
        return { result: 'no_merge', reason: 'rejected_claim' };
      }
      const plan = buildAutoAcceptMergePlan(leftCandidate, rightCandidate);
      if (plan.result !== 'ready') {
        return plan as AutoAcceptMergeResult;
      }
      const result = await repository.autoAcceptMergeClaims({
        candidateId: candidate.candidateId,
        survivor: plan.survivor,
        duplicate: plan.duplicate,
        values: plan.values,
        ...(plan.current !== undefined ? { current: plan.current } : {}),
        messages: plan.messages
      });
      switch (result.status) {
        case 'saved':
          return {
            result: 'auto_accepted',
            survivor: result.survivor,
            duplicate: result.duplicate,
            noticeId: result.notice.noticeId
          };
        case 'conflict':
          throw new VersionConflictError('Claims', result.current);
        case 'not_eligible':
          return { result: 'candidate_review_required' };
        case 'missing':
          throw new RecordNotFoundError('Claim pair');
      }
    },

    async autoAcceptHighConfidenceDuplicates(userId) {
      const candidate = await requireCandidate(userId);
      const candidateId = candidate.candidateId;
      const claims = await repository.listClaims(candidateId, {
        status: ['pending', 'accepted', 'auto_accepted']
      });
      const byType = new Map<string, ClaimRecord[]>();
      for (const claim of claims) {
        const group = byType.get(claim.claimType) ?? [];
        group.push(claim);
        byType.set(claim.claimType, group);
      }
      let applied = 0;
      let skipped = 0;
      const touched = new Set<string>();
      for (const group of byType.values()) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const left = group[i];
            const right = group[j];
            if (touched.has(left.claimId) || touched.has(right.claimId)) {
              skipped += 1;
              continue;
            }
            const [leftCandidate, rightCandidate] = await toMergeCandidates(
              candidateId,
              [left, right]
            );
            if (!leftCandidate || !rightCandidate) {
              skipped += 1;
              continue;
            }
            const plan = buildAutoAcceptMergePlan(leftCandidate, rightCandidate);
            if (plan.result !== 'ready') {
              skipped += 1;
              continue;
            }
            let result: Awaited<
              ReturnType<typeof repository.autoAcceptMergeClaims>
            >;
            try {
              result = await repository.autoAcceptMergeClaims({
                candidateId,
                survivor: plan.survivor,
                duplicate: plan.duplicate,
                values: plan.values,
                ...(plan.current !== undefined ? { current: plan.current } : {}),
                messages: plan.messages
              });
            } catch {
              // Version conflict or overlap: leave for the Issues UI.
              skipped += 1;
              continue;
            }
            if (result.status === 'saved') {
              touched.add(result.survivor.claimId);
              touched.add(result.duplicate.claimId);
              applied += 1;
            } else {
              skipped += 1;
            }
          }
        }
      }
      return { applied, skipped };
    },

    async acknowledgeAutoMerge(userId, claimId, expectedVersion) {
      const candidate = await requireCandidate(userId);
      const claim = await requireClaim(candidate.candidateId, claimId);
      if (expectedVersion !== undefined && claim.version !== expectedVersion) {
        throw new VersionConflictError('Claim', claim);
      }
      const acknowledged = await repository.acknowledgeAutoMergeNotices(
        candidate.candidateId,
        claimId
      );
      const remaining = await repository.countOpenAutoMergeNotices(
        candidate.candidateId,
        claimId
      );
      let status = claim.status;
      if (claim.status === 'auto_accepted' && remaining === 0) {
        const updated = await repository.setClaimStatus(
          candidate.candidateId,
          claimId,
          'accepted',
          claim.version
        );
        if (updated) {
          status = updated.status;
        }
      }
      return { status, acknowledged };
    },

    async keepAutoMergedClaimsSeparate(userId, claimId, expectedVersion) {
      const candidate = await requireCandidate(userId);
      const result = await repository.keepAutoMergedClaimsSeparate(
        candidate.candidateId,
        claimId,
        expectedVersion
      );
      if (result.status === 'missing') {
        throw new RecordNotFoundError('Claim', claimId);
      }
      if (result.status === 'conflict') {
        throw new VersionConflictError('Claim', result.current);
      }
      if (result.status === 'not_eligible') {
        throw new AutoMergeCannotBeRevertedError(result.current);
      }
      if (result.status === 'saved') {
        return { claims: result.claims };
      }
      throw new Error('Unexpected auto-merge reversal result');
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
      const [leftCandidate, rightCandidate] = await toMergeCandidates(
        candidate.candidateId,
        [left, right]
      );
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

    async mergeConfirmedClaimGroup(userId, input) {
      const claimIds = input.claims.map(({ claimId }) => claimId);
      const uniqueClaimIds = new Set(claimIds);
      if (
        claimIds.length < 2 ||
        uniqueClaimIds.size !== claimIds.length ||
        !uniqueClaimIds.has(input.survivorClaimId)
      ) {
        return { result: 'not_eligible', reason: 'invalid_claim_group' };
      }

      const candidate = await requireCandidate(userId);
      const groupClaims = await Promise.all(
        claimIds.map((claimId) => requireClaim(candidate.candidateId, claimId))
      );
      const expectedVersions = new Map(
        input.claims.map(({ claimId, version }) => [claimId, version])
      );
      if (
        groupClaims.some(
          (claim) => expectedVersions.get(claim.claimId) !== claim.version
        )
      ) {
        throw new VersionConflictError('Claims', groupClaims);
      }
      const claimType = groupClaims[0]?.claimType;
      if (
        claimType === undefined ||
        groupClaims.some(
          (claim) =>
            claim.claimType !== claimType ||
            claim.status === 'rejected' ||
            claim.supersededByClaimId !== null
        )
      ) {
        return { result: 'not_eligible', reason: 'ineligible_claim_group' };
      }

      const values = prepareUnknownClaimValues(claimType, input.values);
      const mergeCandidates = await toMergeCandidates(
        candidate.candidateId,
        groupClaims
      );
      if (mergeCandidates.some((claim) => claim === null)) {
        return { result: 'not_eligible', reason: 'ineligible_claim_group' };
      }

      const adjacency = new Map<string, Set<string>>(
        claimIds.map((claimId) => [claimId, new Set<string>()])
      );
      const unresolvedFields = new Set<string>();
      for (let leftIndex = 0; leftIndex < mergeCandidates.length; leftIndex += 1) {
        const left = mergeCandidates[leftIndex];
        if (!left) {
          continue;
        }
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < mergeCandidates.length;
          rightIndex += 1
        ) {
          const right = mergeCandidates[rightIndex];
          if (!right) {
            continue;
          }
          const proposal = buildClaimMergeProposal(left, right);
          if (proposal.result !== 'proposal') {
            continue;
          }
          adjacency.get(left.claimId)?.add(right.claimId);
          adjacency.get(right.claimId)?.add(left.claimId);
          proposal.unresolvedFields.forEach((field) => unresolvedFields.add(field));
        }
      }

      const visited = new Set<string>();
      const pending = [input.survivorClaimId];
      while (pending.length > 0) {
        const claimId = pending.pop();
        if (!claimId || visited.has(claimId)) {
          continue;
        }
        visited.add(claimId);
        adjacency.get(claimId)?.forEach((neighbor) => pending.push(neighbor));
      }
      if (visited.size !== claimIds.length) {
        return { result: 'not_eligible', reason: 'disconnected_claim_group' };
      }

      const hasEndDate = typeof values.endDate === 'string';
      if (input.current === true && hasEndDate) {
        return { result: 'not_eligible', reason: 'inconsistent_current' };
      }
      const missingFields = [...unresolvedFields].filter((field) => {
        if (field === 'endDate') {
          return (
            input.current === undefined ||
            (input.current === true ? hasEndDate : !hasEndDate)
          );
        }
        return values[field] === undefined;
      });
      if (missingFields.length > 0) {
        return {
          result: 'not_eligible',
          reason: `missing_field_choice:${missingFields.sort().join(',')}`
        };
      }

      const result = await repository.mergeConfirmedClaimGroup({
        candidateId: candidate.candidateId,
        claims: input.claims.map(({ claimId, version }) => ({
          claimId,
          expectedVersion: version
        })),
        survivorClaimId: input.survivorClaimId,
        values,
        ...(input.current !== undefined ? { current: input.current } : {})
      });
      switch (result.status) {
        case 'saved':
          await normalize(result.survivor);
          return {
            result: 'merged',
            survivor: result.survivor,
            duplicates: result.duplicates
          };
        case 'conflict':
          throw new VersionConflictError('Claims', result.current);
        case 'not_eligible':
          return { result: 'not_eligible', reason: 'ineligible_claim_group' };
        case 'missing':
          throw new RecordNotFoundError('Claim group');
      }
    },

    async resolveClaimBatch(userId, actions) {
      const seenClaimIds = new Set<string>();
      const overlappingClaimIds = new Set<string>();
      for (const action of actions) {
        const claimIds =
          action.action === 'accept_claim'
            ? [action.claimId]
            : action.action === 'merge_claims'
              ? [action.leftClaimId, action.rightClaimId]
              : action.claims.map(({ claimId }) => claimId);
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

          if (action.action === 'merge_claim_group') {
            const result = await service.mergeConfirmedClaimGroup(userId, action);
            if (result.result === 'merged') {
              return {
                index,
                action: action.action,
                status: 'accepted',
                survivor: result.survivor,
                duplicates: result.duplicates
              };
            }
            return {
              index,
              action: action.action,
              status: 'not_eligible',
              reason: result.reason
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
        repository.listClaims(candidate.candidateId, {
          status: ['accepted', 'auto_accepted']
        })
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
