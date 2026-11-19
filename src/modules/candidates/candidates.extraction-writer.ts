import { isDeepStrictEqual } from 'node:util';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import type {
  CandidatesRepository,
  ClaimRecord,
  CreateClaimSourceOccurrenceInput,
  ClaimValues,
  CreateClaimInput
} from './candidates.repository.js';
import type { ClaimSourceAnchor } from './candidates.table.js';
import { prepareUnknownClaimValues } from './candidates.claim-values.js';
import {
  buildClaimMergeProposal,
  type MergeCandidateClaim,
  strictClaimComparisonKey,
  toMergeCandidateClaim
} from './candidates.claim-comparison.js';

export interface ExtractedClaimSourceOccurrenceInput {
  anchorKey: string;
  references: string[];
  fields: string[];
  anchor: ClaimSourceAnchor;
}

export interface ExtractedClaimDraftInput {
  type: CreateClaimInput['claimType'];
  status: Extract<CreateClaimInput['status'], 'accepted' | 'pending'>;
  values: ClaimValues;
  rawValues: Record<string, string>;
  fieldSources: Record<string, string[]>;
  current: boolean;
  sourceOccurrences: ExtractedClaimSourceOccurrenceInput[];
}

export interface CandidateExtractionWriter {
  saveExtractedClaims(
    userId: string,
    documentId: string,
    invocationId: string,
    drafts: ExtractedClaimDraftInput[],
    transaction: DatabaseExecutor
  ): Promise<ClaimRecord[]>;
  saveResolvedClaim(
    userId: string,
    input: ResolvedExtractionClaimInput,
    transaction: DatabaseExecutor
  ): Promise<ClaimRecord>;
}

export interface ResolvedExtractionClaimInput {
  type: CreateClaimInput['claimType'];
  values: unknown;
  documentId: string;
  invocationId: string;
  rawValues: Record<string, string>;
  fieldSources: Record<string, string[]>;
  current: boolean;
}

// Canonical terms let values written differently ("Postgres" and
// "PostgreSQL") compare as one value. Drafts are not saved yet, so their terms
// come from the dictionary; saved claims use their normalization decisions.
export interface ExtractionTermLookup {
  findDictionaryTerms(
    claims: { claimType: string; values: ClaimValues }[]
  ): Promise<(Record<string, string> | undefined)[]>;
  findNormalizedTerms(claims: ClaimRecord[]): Promise<Map<string, Record<string, string>>>;
}

export interface CandidateExtractionWriterDependencies {
  repository: Pick<
    CandidatesRepository,
    | 'findCandidateByUserId'
    | 'deletePendingExtractedClaims'
    | 'listReviewedExtractedClaims'
    | 'listClaims'
    | 'createClaim'
    | 'createClaims'
    | 'createClaimSourceOccurrences'
  >;
  // Without it, values are compared as written.
  termLookup?: ExtractionTermLookup;
}

function toDraftMergeCandidate(
  candidateId: string,
  draft: ExtractedClaimDraftInput,
  index: number,
  normalizedTerms?: Record<string, string>
): MergeCandidateClaim {
  return {
    candidateId,
    claimId: `extraction-draft-${index}`,
    claimType: draft.type,
    origin: 'extracted',
    status: draft.status,
    candidateEdited: false,
    values: draft.values,
    current: draft.current,
    version: 1,
    createdAt: new Date(0),
    ...(normalizedTerms ? { normalizedTerms } : {})
  };
}

// An existing claim that states exactly what the draft states: the same
// identity and every field the same, counting spellings of one canonical term
// as the same. The draft adds only a source, so it is kept as a source of that
// claim rather than as a duplicate (FR-AN-07). A draft that adds or changes
// any value is not matched, so nothing the candidate reviewed is overwritten.
function findSameExistingClaim(
  draft: MergeCandidateClaim,
  existingClaims: MergeCandidateClaim[]
): MergeCandidateClaim | undefined {
  return existingClaims.find((existing) => {
    const proposal = buildClaimMergeProposal(draft, existing);
    return (
      proposal.result === 'proposal' &&
      proposal.identity === 'equivalent' &&
      Object.values(proposal.fields).every((field) => field.kind === 'same')
    );
  });
}

function keepConflictingDraftsPending(
  drafts: ExtractedClaimDraftInput[],
  draftCandidates: MergeCandidateClaim[],
  existingCandidates: MergeCandidateClaim[]
): void {
  drafts.forEach((draft, index) => {
    if (draft.status !== 'accepted') {
      return;
    }
    const candidate = draftCandidates[index];
    if (!candidate) {
      return;
    }
    const comparisons = [
      ...existingCandidates,
      ...draftCandidates.filter((_, otherIndex) => otherIndex !== index)
    ];
    const hasConflict = comparisons.some((other) => {
      const proposal = buildClaimMergeProposal(candidate, other);
      return proposal.result === 'proposal' && proposal.unresolvedFields.length > 0;
    });
    if (hasConflict) {
      draft.status = 'pending';
      candidate.status = 'pending';
    }
  });
}

export class ConflictingSourceOccurrenceError extends Error {
  readonly code = 'CONFLICTING_SOURCE_OCCURRENCE';

  constructor(readonly anchorKey: string) {
    super(`Source occurrence '${anchorKey}' has conflicting physical anchors`);
    this.name = 'ConflictingSourceOccurrenceError';
  }
}

function mergeUnique(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function mergeFieldSources(
  left: Record<string, string[]>,
  right: Record<string, string[]>
): Record<string, string[]> {
  const merged = Object.fromEntries(
    Object.entries(left).map(([field, references]) => [field, [...references]])
  );
  for (const [field, references] of Object.entries(right)) {
    merged[field] = mergeUnique(merged[field] ?? [], references);
  }
  return merged;
}

function mergeSourceOccurrences(
  left: ExtractedClaimSourceOccurrenceInput[],
  right: ExtractedClaimSourceOccurrenceInput[]
): ExtractedClaimSourceOccurrenceInput[] {
  const merged = new Map(
    left.map((occurrence) => [
      occurrence.anchorKey,
      {
        ...occurrence,
        references: [...occurrence.references],
        fields: [...occurrence.fields]
      }
    ])
  );

  for (const occurrence of right) {
    const existing = merged.get(occurrence.anchorKey);
    if (existing) {
      if (!isDeepStrictEqual(existing.anchor, occurrence.anchor)) {
        throw new ConflictingSourceOccurrenceError(occurrence.anchorKey);
      }
      existing.references = mergeUnique(
        existing.references,
        occurrence.references
      );
      existing.fields = mergeUnique(existing.fields, occurrence.fields);
    } else {
      merged.set(occurrence.anchorKey, {
        ...occurrence,
        references: [...occurrence.references],
        fields: [...occurrence.fields]
      });
    }
  }

  return [...merged.values()];
}

function validateSourceOccurrenceAnchors(
  drafts: ExtractedClaimDraftInput[]
): void {
  const anchorsByKey = new Map<string, ClaimSourceAnchor>();

  for (const draft of drafts) {
    for (const occurrence of draft.sourceOccurrences) {
      const existing = anchorsByKey.get(occurrence.anchorKey);
      if (existing && !isDeepStrictEqual(existing, occurrence.anchor)) {
        throw new ConflictingSourceOccurrenceError(occurrence.anchorKey);
      }
      anchorsByKey.set(occurrence.anchorKey, occurrence.anchor);
    }
  }
}

function coalesceDrafts(
  drafts: ExtractedClaimDraftInput[]
): ExtractedClaimDraftInput[] {
  const merged = new Map<string, ExtractedClaimDraftInput>();

  for (const draft of drafts) {
    const key = strictClaimComparisonKey(draft.type, draft.values);
    const existing = merged.get(key);
    if (existing) {
      if (draft.status === 'pending') {
        existing.status = 'pending';
      }
      existing.fieldSources = mergeFieldSources(
        existing.fieldSources,
        draft.fieldSources
      );
      existing.sourceOccurrences = mergeSourceOccurrences(
        existing.sourceOccurrences,
        draft.sourceOccurrences
      );
      existing.current ||= draft.current;
    } else {
      merged.set(key, {
        ...draft,
        values: { ...draft.values },
        rawValues: { ...draft.rawValues },
        fieldSources: mergeFieldSources({}, draft.fieldSources),
        sourceOccurrences: mergeSourceOccurrences([], draft.sourceOccurrences)
      });
    }
  }

  return [...merged.values()];
}

export function createCandidateExtractionWriter({
  repository,
  termLookup
}: CandidateExtractionWriterDependencies): CandidateExtractionWriter {
  async function loadTerms(
    drafts: ExtractedClaimDraftInput[],
    activeClaims: ClaimRecord[]
  ): Promise<{
    draftTerms: (Record<string, string> | undefined)[];
    claimTerms: Map<string, Record<string, string>>;
  }> {
    if (!termLookup) {
      return { draftTerms: [], claimTerms: new Map() };
    }
    try {
      const [draftTerms, claimTerms] = await Promise.all([
        termLookup.findDictionaryTerms(
          drafts.map((draft) => ({ claimType: draft.type, values: draft.values }))
        ),
        termLookup.findNormalizedTerms(activeClaims)
      ]);
      return { draftTerms, claimTerms };
    } catch {
      // Terms only refine the comparison; saving the extraction must not fail
      // because the dictionary could not be read.
      return { draftTerms: [], claimTerms: new Map() };
    }
  }

  return {
    async saveExtractedClaims(
      userId,
      documentId,
      invocationId,
      drafts,
      transaction
    ) {
      const candidate = await repository.findCandidateByUserId(
        userId,
        transaction
      );
      if (!candidate) {
        throw new RecordNotFoundError('Candidate profile');
      }
      validateSourceOccurrenceAnchors(drafts);
      const coalescedDrafts = coalesceDrafts(drafts);

      await repository.deletePendingExtractedClaims(
        candidate.candidateId,
        documentId,
        transaction
      );
      const reviewedClaims = await repository.listReviewedExtractedClaims(
        candidate.candidateId,
        documentId,
        transaction
      );
      const reviewedClaimKeys = new Set(
        reviewedClaims.map((claim) =>
          strictClaimComparisonKey(claim.claimType, claim.values)
        )
      );

      const draftsToCreate = coalescedDrafts.filter(
        (draft) =>
          !reviewedClaimKeys.has(
            strictClaimComparisonKey(draft.type, draft.values)
          )
      );
      const activeClaims = (
        await repository.listClaims(candidate.candidateId, {}, transaction)
      ).filter(
        (claim) => claim.status !== 'rejected' && claim.supersededByClaimId === null
      );
      const { draftTerms, claimTerms } = await loadTerms(draftsToCreate, activeClaims);
      const existingCandidates = activeClaims
        .map((claim) =>
          toMergeCandidateClaim(candidate.candidateId, claim, claimTerms.get(claim.claimId))
        )
        .filter((claim): claim is MergeCandidateClaim => claim !== null);

      const newDrafts: ExtractedClaimDraftInput[] = [];
      const newDraftCandidates: MergeCandidateClaim[] = [];
      const sourcesOfExistingClaims: CreateClaimSourceOccurrenceInput[] = [];
      draftsToCreate.forEach((draft, index) => {
        const draftCandidate = toDraftMergeCandidate(
          candidate.candidateId,
          draft,
          index,
          draftTerms[index]
        );
        const sameClaim = findSameExistingClaim(draftCandidate, existingCandidates);
        if (!sameClaim) {
          newDrafts.push(draft);
          newDraftCandidates.push(draftCandidate);
          return;
        }
        for (const occurrence of draft.sourceOccurrences) {
          sourcesOfExistingClaims.push({
            claimId: sameClaim.claimId,
            documentId,
            anchorKey: occurrence.anchorKey,
            sourceReferences: occurrence.references,
            fieldNames: occurrence.fields,
            anchor: occurrence.anchor
          });
        }
      });

      keepConflictingDraftsPending(newDrafts, newDraftCandidates, existingCandidates);
      const inputs: CreateClaimInput[] = newDrafts.map((draft) => ({
        candidateId: candidate.candidateId,
        claimType: draft.type,
        origin: 'extracted',
        status: draft.status,
        values: draft.values,
        extraction: {
          invocationId,
          sourceDocumentId: documentId,
          rawValues: draft.rawValues,
          fieldSources: draft.fieldSources,
          current: draft.current
        }
      }));

      const createdClaims = await repository.createClaims(inputs, transaction);
      if (createdClaims.length !== newDrafts.length) {
        throw new Error('Created claims did not match extraction drafts');
      }

      const occurrenceInputs: CreateClaimSourceOccurrenceInput[] =
        createdClaims.flatMap((claim, index) =>
          newDrafts[index]!.sourceOccurrences.map((occurrence) => ({
            claimId: claim.claimId,
            documentId,
            anchorKey: occurrence.anchorKey,
            sourceReferences: occurrence.references,
            fieldNames: occurrence.fields,
            anchor: occurrence.anchor
          }))
        );
      await repository.createClaimSourceOccurrences(
        [...occurrenceInputs, ...sourcesOfExistingClaims],
        transaction
      );

      // Claims that only gained a source are already saved and normalized.
      return createdClaims;
    },
    async saveResolvedClaim(userId, input, transaction) {
      const candidate = await repository.findCandidateByUserId(userId, transaction);
      if (!candidate) {
        throw new RecordNotFoundError('Candidate profile');
      }

      return repository.createClaim(
        {
          candidateId: candidate.candidateId,
          claimType: input.type,
          origin: 'extracted',
          status: 'accepted',
          values: prepareUnknownClaimValues(input.type, input.values),
          extraction: {
            invocationId: input.invocationId,
            sourceDocumentId: input.documentId,
            rawValues: input.rawValues,
            fieldSources: input.fieldSources,
            current: input.current
          }
        },
        transaction
      );
    }
  };
}
