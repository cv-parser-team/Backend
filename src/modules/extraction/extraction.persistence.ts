import type {
  DatabaseExecutor,
  UnitOfWork
} from '../../infrastructure/database/unit-of-work.js';
import type {
  CandidateExtractionWriter,
  ExtractedClaimDraftInput
} from '../candidates/index.js';
import type { ExtractionResult, ParsingService } from '../parsing/index.js';
import type { CandidateExtractionResult } from './extraction.service.js';
import { mapClaimSourceOccurrences } from './extraction.source-occurrences.js';

export type PersistedExtractionClaims = Awaited<
  ReturnType<CandidateExtractionWriter['saveExtractedClaims']>
>;

export interface PersistCandidateExtractionInput {
  documentId: string;
  ownerUserId: string;
  result: CandidateExtractionResult;
  sourceContent: Pick<ExtractionResult, 'pages' | 'blocks'>;
}

export interface ExtractionPersistenceCoordinator {
  persist(
    input: PersistCandidateExtractionInput,
    transaction?: DatabaseExecutor
  ): Promise<PersistedExtractionClaims>;
}

export interface ExtractionPersistenceCoordinatorDependencies {
  candidateWriter: CandidateExtractionWriter;
  parsingService: Pick<ParsingService, 'saveUnmappedData'>;
  unitOfWork: UnitOfWork;
}

export function createExtractionPersistenceCoordinator({
  candidateWriter,
  parsingService,
  unitOfWork
}: ExtractionPersistenceCoordinatorDependencies): ExtractionPersistenceCoordinator {
  async function persistWithTransaction(
    {
      documentId,
      ownerUserId,
      result,
      sourceContent
    }: PersistCandidateExtractionInput,
    transaction: DatabaseExecutor
  ): Promise<PersistedExtractionClaims> {
    const drafts: ExtractedClaimDraftInput[] = result.claims.map((claim) => ({
      type: claim.type,
      values: claim.values,
      rawValues: claim.rawValues,
      fieldSources: claim.fieldSources,
      current: claim.current,
      sourceOccurrences: mapClaimSourceOccurrences(claim, sourceContent)
    }));

    const claims = await candidateWriter.saveExtractedClaims(
      ownerUserId,
      documentId,
      result.invocationId,
      drafts,
      transaction
    );
    await parsingService.saveUnmappedData(
      documentId,
      result.unmapped,
      transaction
    );

    return claims;
  }

  return {
    persist(input, transaction) {
      if (transaction) {
        return persistWithTransaction(input, transaction);
      }
      return unitOfWork.run((ownedTransaction) =>
        persistWithTransaction(input, ownedTransaction)
      );
    }
  };
}
