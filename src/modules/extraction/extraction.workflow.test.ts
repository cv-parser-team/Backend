import { describe, expect, it, vi } from 'vitest';
import type { ExtractionPersistenceCoordinator } from './extraction.persistence.js';
import type {
  CandidateExtractionResult,
  CandidateExtractionService
} from './extraction.service.js';
import { createCandidateExtractionWorkflow } from './extraction.workflow.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const ownerUserId = '22222222-2222-4222-8222-222222222222';
const invocationId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const input = 'L1 Ada Lovelace';

const extractionResult: CandidateExtractionResult = {
  invocationId,
  version: 1,
  profile: { values: {}, rawValues: {}, confidence: {}, sources: {} },
  claims: [],
  unmapped: []
};

function dependencies() {
  const extract = vi
    .fn<CandidateExtractionService['extract']>()
    .mockResolvedValue(extractionResult);
  const persist = vi
    .fn<ExtractionPersistenceCoordinator['persist']>()
    .mockResolvedValue([]);
  const workflow = createCandidateExtractionWorkflow({
    extractionService: { extract },
    persistenceCoordinator: { persist }
  });

  return { extract, persist, workflow };
}

describe('candidate extraction workflow', () => {
  it('extracts and persists the mapped result', async () => {
    const { extract, persist, workflow } = dependencies();

    await expect(
      workflow.run({ documentId, ownerUserId, operationId, input })
    ).resolves.toEqual({ invocationId, persistedClaimCount: 0 });
    expect(extract).toHaveBeenCalledWith({ operationId, input });
    expect(persist).toHaveBeenCalledWith({
      documentId,
      ownerUserId,
      result: extractionResult
    });
  });

  it('does not persist when extraction fails', async () => {
    const { extract, persist, workflow } = dependencies();
    const failure = new Error('extraction failed');
    extract.mockRejectedValue(failure);

    await expect(
      workflow.run({ documentId, ownerUserId, operationId, input })
    ).rejects.toBe(failure);
    expect(persist).not.toHaveBeenCalled();
  });
});
