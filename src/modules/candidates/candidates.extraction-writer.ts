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

export interface ExtractedClaimSourceOccurrenceInput {
  anchorKey: string;
  references: string[];
  fields: string[];
  anchor: ClaimSourceAnchor;
}

export interface ExtractedClaimDraftInput {
  type: CreateClaimInput['claimType'];
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

export interface CandidateExtractionWriterDependencies {
  repository: Pick<
    CandidatesRepository,
    | 'findCandidateByUserId'
    | 'deletePendingExtractedClaims'
    | 'listReviewedExtractedClaims'
    | 'createClaim'
    | 'createClaims'
    | 'createClaimSourceOccurrences'
  >;
}

export class ConflictingSourceOccurrenceError extends Error {
  readonly code = 'CONFLICTING_SOURCE_OCCURRENCE';

  constructor(readonly anchorKey: string) {
    super(`Source occurrence '${anchorKey}' has conflicting physical anchors`);
    this.name = 'ConflictingSourceOccurrenceError';
  }
}

function normalizeComparisonText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map(normalizeComparisonText))].sort();
}

function claimKey(
  claimType: CreateClaimInput['claimType'],
  values: ClaimValues
): string {
  const normalizedValues = Object.entries(values)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? normalizeList(value) : normalizeComparisonText(value)
    ]);

  return JSON.stringify([claimType, normalizedValues]);
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
    const key = claimKey(draft.type, draft.values);
    const existing = merged.get(key);
    if (existing) {
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
  repository
}: CandidateExtractionWriterDependencies): CandidateExtractionWriter {
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
          claimKey(claim.claimType, claim.values)
        )
      );

      const draftsToCreate = coalescedDrafts.filter(
        (draft) =>
          !reviewedClaimKeys.has(claimKey(draft.type, draft.values))
      );
      const inputs: CreateClaimInput[] = draftsToCreate.map((draft) => ({
        candidateId: candidate.candidateId,
        claimType: draft.type,
        origin: 'extracted',
        status: 'pending',
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
      if (createdClaims.length !== draftsToCreate.length) {
        throw new Error('Created claims did not match extraction drafts');
      }

      const occurrenceInputs: CreateClaimSourceOccurrenceInput[] =
        createdClaims.flatMap((claim, index) =>
          draftsToCreate[index]!.sourceOccurrences.map((occurrence) => ({
            claimId: claim.claimId,
            documentId,
            anchorKey: occurrence.anchorKey,
            sourceReferences: occurrence.references,
            fieldNames: occurrence.fields,
            anchor: occurrence.anchor
          }))
        );
      await repository.createClaimSourceOccurrences(
        occurrenceInputs,
        transaction
      );

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
