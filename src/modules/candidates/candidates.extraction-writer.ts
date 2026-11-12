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
    invocationId: string,
    drafts: ExtractedClaimDraftInput[],
    transaction: DatabaseExecutor
  ): Promise<ClaimRecord[]>;
}

export interface CandidateExtractionWriterDependencies {
  repository: Pick<
    CandidatesRepository,
    'findCandidateByUserId' | 'createClaim'
  >;
}

export function createCandidateExtractionWriter({
  repository
}: CandidateExtractionWriterDependencies): CandidateExtractionWriter {
  return {
    async saveExtractedClaims(userId, invocationId, drafts, transaction) {
      const candidate = await repository.findCandidateByUserId(
        userId,
        transaction
      );
      if (!candidate) {
        throw new RecordNotFoundError('Candidate profile');
      }

      const saved: ClaimRecord[] = [];
      for (const draft of drafts) {
        saved.push(
          await repository.createClaim(
            {
              candidateId: candidate.candidateId,
              claimType: draft.type,
              origin: 'extracted',
              status: 'pending',
              values: draft.values,
              extraction: {
                invocationId,
                rawValues: draft.rawValues,
                fieldSources: draft.fieldSources,
                current: draft.current
              }
            },
            transaction
          )
        );
      }
      return saved;
    }
  };
}
