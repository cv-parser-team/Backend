import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import type {
  CandidatesRepository,
  ClaimRecord,
  ClaimValues,
  CreateClaimInput
} from './candidates.repository.js';

export interface ExtractedClaimDraftInput {
  type: CreateClaimInput['claimType'];
  values: ClaimValues;
  rawValues: Record<string, string>;
  fieldSources: Record<string, string[]>;
  current: boolean;
}

export interface CandidateExtractionWriter {
  saveExtractedClaims(
    userId: string,
    documentId: string,
    invocationId: string,
    drafts: ExtractedClaimDraftInput[],
    transaction: DatabaseExecutor
  ): Promise<ClaimRecord[]>;
}

export interface CandidateExtractionWriterDependencies {
  repository: Pick<
    CandidatesRepository,
    | 'findCandidateByUserId'
    | 'deletePendingExtractedClaims'
    | 'listReviewedExtractedClaims'
    | 'createClaims'
  >;
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function claimKey(
  claimType: CreateClaimInput['claimType'],
  values: ClaimValues
): string {
  const normalizedValues = Object.entries(values)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? normalizeList(value) : value
    ]);

  return JSON.stringify([claimType, normalizedValues]);
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

      const inputs: CreateClaimInput[] = drafts
        .filter(
          (draft) =>
            !reviewedClaimKeys.has(claimKey(draft.type, draft.values))
        )
        .map((draft) => ({
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

      return repository.createClaims(inputs, transaction);
    }
  };
}
