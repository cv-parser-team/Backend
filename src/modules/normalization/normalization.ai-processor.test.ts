import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseExecutor,
  UnitOfWork
} from '../../infrastructure/database/unit-of-work.js';
import { LlmError } from '../../infrastructure/llm/llm.errors.js';
import type { AiRequestRecord } from './normalization-ai-requests.repository.js';
import { createAiRequestProcessor } from './normalization.ai-processor.js';
import type { AiMatcher } from './normalization.ai.js';
import type { DictionaryTerm } from './normalization.matching.js';
import type { NormalizationDecisionRecord } from './normalization.repository.js';

const transaction = { name: 'transaction' } as unknown as DatabaseExecutor;
const claimId = '22222222-2222-4222-8222-222222222222';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

function term(termId: string, canonicalName: string): DictionaryTerm {
  return { termId, category: 'job_title', canonicalName, status: 'active', mergedIntoId: null };
}

const backend = term('t-be', 'Backend Developer');
const frontend = term('t-fe', 'Frontend Developer');

function aiRequest(overrides: Partial<AiRequestRecord> = {}): AiRequestRecord {
  return {
    requestId: 'r-1',
    claimId,
    category: 'job_title',
    originalValue: 'Server-side Engineer',
    context: { employer: 'Aramex' },
    preferredTermIds: [],
    status: 'processing',
    attemptCount: 1,
    failureCode: null,
    availableAt: timestamp,
    lockedUntil: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function latestDecision(
  overrides: Partial<NormalizationDecisionRecord> = {}
): NormalizationDecisionRecord {
  return {
    normalizationId: 'n-1',
    claimId,
    termId: null,
    originalValue: 'Server-side Engineer',
    method: null,
    confidenceScore: null,
    actorType: 'system',
    ruleVersion: 'fuzzy-v1',
    status: 'unmatched',
    createdAt: new Date(),
    ...overrides
  };
}

function setup(match: AiMatcher['match'] = vi.fn().mockResolvedValue({
  status: 'matched',
  term: backend,
  confidence: 0.92,
  reason: 'Same role'
})) {
  const dictionary = {
    listActiveTerms: vi.fn().mockResolvedValue([backend, frontend]),
    findAiProposedTerm: vi.fn().mockResolvedValue(null),
    proposeAiAlias: vi.fn().mockResolvedValue(undefined)
  };
  const decisions = {
    saveDecision: vi.fn().mockResolvedValue(latestDecision()),
    findLatestDecision: vi.fn().mockResolvedValue(latestDecision())
  };
  const requests = {
    lockClaimed: vi.fn().mockResolvedValue(aiRequest()),
    complete: vi.fn().mockResolvedValue(true),
    supersede: vi.fn().mockResolvedValue(true),
    retry: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true)
  };
  const matcher = { match: vi.fn(match) };
  const unitOfWork: UnitOfWork = { run: vi.fn((work) => work(transaction)) };
  const processor = createAiRequestProcessor({
    dictionary,
    decisions,
    requests,
    matcher,
    unitOfWork
  });
  return { processor, dictionary, decisions, requests, matcher, unitOfWork };
}

describe('AI request processing', () => {
  it('links the claim, proposes the alias, and completes the request in one transaction', async () => {
    const { processor, decisions, dictionary, requests, matcher } = setup();

    await expect(processor.process(aiRequest())).resolves.toBe('matched');

    expect(matcher.match).toHaveBeenCalledWith({
      operationId: claimId,
      category: 'job_title',
      value: 'Server-side Engineer',
      context: { employer: 'Aramex' },
      terms: [backend, frontend]
    });
    expect(decisions.saveDecision).toHaveBeenCalledWith(
      {
        claimId,
        originalValue: 'Server-side Engineer',
        termId: 't-be',
        method: 'ai',
        confidenceScore: 0.92,
        actorType: 'ai',
        ruleVersion: 'normalization-match-v1',
        status: 'matched'
      },
      transaction
    );
    expect(dictionary.proposeAiAlias).toHaveBeenCalledWith(
      't-be',
      'Server-side Engineer',
      'server-side engineer',
      transaction
    );
    expect(requests.complete).toHaveBeenCalledWith(aiRequest(), transaction);
  });

  it('offers the terms spelling matching found close first', async () => {
    const { processor, matcher } = setup();

    await processor.process(aiRequest({ preferredTermIds: ['t-fe'] }));

    expect(matcher.match).toHaveBeenCalledWith(
      expect.objectContaining({ terms: [frontend, backend] })
    );
  });

  it('reuses an earlier AI match for the same spelling without asking the AI', async () => {
    const { processor, dictionary, matcher, decisions } = setup();
    dictionary.findAiProposedTerm.mockResolvedValue(backend);

    await expect(processor.process(aiRequest())).resolves.toBe('matched');

    expect(dictionary.findAiProposedTerm).toHaveBeenCalledWith(
      'job_title',
      'server-side engineer'
    );
    expect(matcher.match).not.toHaveBeenCalled();
    expect(decisions.saveDecision).toHaveBeenCalledWith(
      expect.objectContaining({ termId: 't-be', method: 'ai' }),
      transaction
    );
  });

  it('records that the AI found no term', async () => {
    const { processor, decisions, dictionary } = setup(
      vi.fn().mockResolvedValue({ status: 'unmatched', reason: 'No term' })
    );

    await expect(processor.process(aiRequest())).resolves.toBe('unmatched');

    expect(decisions.saveDecision).toHaveBeenCalledWith(
      expect.objectContaining({ termId: null, method: 'ai', status: 'unmatched' }),
      transaction
    );
    expect(dictionary.proposeAiAlias).not.toHaveBeenCalled();
  });

  it.each([
    ['the value changed', latestDecision({ originalValue: 'Backend Dev' })],
    ['the claim was linked meanwhile', latestDecision({ status: 'matched', termId: 't-be' })],
    ['the claim has no decision', null]
  ])('supersedes the request when %s', async (_case, latest) => {
    const { processor, decisions, requests } = setup();
    decisions.findLatestDecision.mockResolvedValue(latest);

    await expect(processor.process(aiRequest())).resolves.toBe('superseded');

    expect(requests.supersede).toHaveBeenCalledWith(aiRequest(), transaction);
    expect(decisions.saveDecision).not.toHaveBeenCalled();
  });

  it('writes nothing when another worker claimed the request', async () => {
    const { processor, requests, decisions } = setup();
    requests.lockClaimed.mockResolvedValue(null);

    await expect(processor.process(aiRequest())).resolves.toBe('stale');

    expect(decisions.saveDecision).not.toHaveBeenCalled();
  });

  it.each(['rate_limited', 'timeout', 'provider_unavailable'] as const)(
    'retries later after a %s error',
    async (category) => {
      const { processor, requests, unitOfWork } = setup(
        vi.fn().mockRejectedValue(new LlmError('busy', category))
      );

      await expect(processor.process(aiRequest({ attemptCount: 2 }))).resolves.toBe('retrying');

      expect(requests.retry).toHaveBeenCalledWith(aiRequest({ attemptCount: 2 }), category, 60_000);
      expect(unitOfWork.run).not.toHaveBeenCalled();
    }
  );

  it('fails after the last attempt', async () => {
    const { processor, requests } = setup(
      vi.fn().mockRejectedValue(new LlmError('busy', 'rate_limited'))
    );

    await expect(processor.process(aiRequest({ attemptCount: 3 }))).resolves.toBe('failed');

    expect(requests.retry).not.toHaveBeenCalled();
    expect(requests.fail).toHaveBeenCalledWith(aiRequest({ attemptCount: 3 }), 'rate_limited');
  });

  it.each(['authentication', 'configuration', 'invalid_request'] as const)(
    'fails at once after a %s error',
    async (category) => {
      const { processor, requests } = setup(
        vi.fn().mockRejectedValue(new LlmError('denied', category))
      );

      await expect(processor.process(aiRequest())).resolves.toBe('failed');

      expect(requests.fail).toHaveBeenCalledWith(aiRequest(), category);
    }
  );

  it('throws errors that are not provider failures with their real cause', async () => {
    const databaseError = new Error('connection terminated');
    const { processor, requests } = setup(vi.fn().mockRejectedValue(databaseError));

    await expect(processor.process(aiRequest())).rejects.toBe(databaseError);

    expect(requests.retry).not.toHaveBeenCalled();
    expect(requests.fail).not.toHaveBeenCalled();
  });

  it('fails a request claimed more often than the attempt limit without asking the AI', async () => {
    const { processor, requests, matcher, dictionary } = setup();

    await expect(processor.process(aiRequest({ attemptCount: 4 }))).resolves.toBe('failed');

    expect(requests.fail).toHaveBeenCalledWith(
      aiRequest({ attemptCount: 4 }),
      'max_attempts_exceeded'
    );
    expect(dictionary.findAiProposedTerm).not.toHaveBeenCalled();
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('fails output that breaks the contract', async () => {
    const { processor, requests, decisions } = setup(
      vi.fn().mockResolvedValue({ status: 'invalid', reason: 'Choice 9 is not in the list' })
    );

    await expect(processor.process(aiRequest())).resolves.toBe('failed');

    expect(requests.fail).toHaveBeenCalledWith(aiRequest(), 'invalid_output');
    expect(decisions.saveDecision).not.toHaveBeenCalled();
  });

  it('reports a stale request when its retry no longer matches', async () => {
    const { processor, requests } = setup(
      vi.fn().mockRejectedValue(new LlmError('busy', 'timeout'))
    );
    requests.retry.mockResolvedValue(false);

    await expect(processor.process(aiRequest())).resolves.toBe('stale');
  });
});
