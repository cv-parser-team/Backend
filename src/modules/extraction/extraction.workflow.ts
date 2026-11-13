import type {
  ExtractionPersistenceCoordinator,
  PersistedExtractionClaims
} from './extraction.persistence.js';
import type { CandidateExtractionService } from './extraction.service.js';

export interface CandidateExtractionWorkflowInput {
  documentId: string;
  ownerUserId: string;
  operationId: string;
  input: string;
}

export interface CandidateExtractionWorkflowResult {
  invocationId: string;
  persistedClaimCount: number;
}

export interface CandidateExtractionWorkflow {
  run(
    input: CandidateExtractionWorkflowInput
  ): Promise<CandidateExtractionWorkflowResult>;
}

export interface CandidateExtractionWorkflowDependencies {
  extractionService: CandidateExtractionService;
  persistenceCoordinator: ExtractionPersistenceCoordinator;
}

export function createCandidateExtractionWorkflow({
  extractionService,
  persistenceCoordinator
}: CandidateExtractionWorkflowDependencies): CandidateExtractionWorkflow {
  return {
    async run({ documentId, ownerUserId, operationId, input }) {
      const result = await extractionService.extract({ operationId, input });
      const claims: PersistedExtractionClaims =
        await persistenceCoordinator.persist({
          documentId,
          ownerUserId,
          result
        });

      return {
        invocationId: result.invocationId,
        persistedClaimCount: claims.length
      };
    }
  };
}
