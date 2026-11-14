import type { AppDatabase } from '../../infrastructure/database/database.js';
import { createUnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import { createCandidateExtractionWriter } from '../candidates/index.js';
import type { ParsingService } from '../parsing/index.js';
import {
  createExtractionPersistenceCoordinator as createPersistenceCoordinator
} from './extraction.persistence.js';
import type { CandidateExtractionService } from './extraction.service.js';
import { createExtractionReviewRepository } from './extraction-review.repository.js';
import {
  createCandidateExtractionWorkflow as createWorkflow,
  type CandidateExtractionWorkflow
} from './extraction.workflow.js';

export {
  createCandidateExtractionService,
  EXTRACTION_PROMPT,
  EXTRACTION_PROMPT_VERSION
} from './extraction.service.js';
export {
  InvalidExtractionProvenanceError,
  SourceReferenceResolutionError
} from './extraction.errors.js';
export type {
  CandidateExtractionRequest,
  CandidateExtractionResult,
  CandidateExtractionService,
  CandidateExtractionServiceDependencies
} from './extraction.service.js';
export { createExtractionPersistenceCoordinator } from './extraction.persistence.js';
export type {
  ExtractionPersistenceCoordinator,
  ExtractionPersistenceCoordinatorDependencies,
  PersistCandidateExtractionInput,
  PersistedExtractionClaims
} from './extraction.persistence.js';
export { createCandidateExtractionWorkflow } from './extraction.workflow.js';
export type {
  CandidateExtractionWorkflow,
  CandidateExtractionWorkflowDependencies,
  CandidateExtractionWorkflowInput,
  CandidateExtractionWorkflowResult
} from './extraction.workflow.js';
export { mapClaimSourceOccurrences } from './extraction.source-occurrences.js';
export type { ClaimSourceOccurrenceDraft } from './extraction.source-occurrences.js';
export { createExtractionReviewRepository } from './extraction-review.repository.js';
export type {
  ExtractionReviewItemRecord,
  ExtractionReviewRepository
} from './extraction-review.repository.js';
export type {
  ExtractionReviewIssue,
  ExtractionReviewItemDraft
} from './extraction.mapper.js';

export interface CandidateExtractionWorkflowComposition {
  database: AppDatabase;
  parsingService: Pick<ParsingService, 'saveUnmappedData'>;
  extractionService: CandidateExtractionService;
}

// Assembles the workflow's concrete persistence dependencies while keeping
// repositories and transaction construction out of the workflow itself.
export function composeCandidateExtractionWorkflow({
  database,
  parsingService,
  extractionService
}: CandidateExtractionWorkflowComposition): CandidateExtractionWorkflow {
  const persistenceCoordinator = createPersistenceCoordinator({
    candidateWriter: createCandidateExtractionWriter(database),
    reviewRepository: createExtractionReviewRepository(database),
    parsingService,
    unitOfWork: createUnitOfWork(database)
  });

  return createWorkflow({ extractionService, persistenceCoordinator });
}
