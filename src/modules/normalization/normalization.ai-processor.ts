import type { UnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import { LlmError, type LlmErrorCategory } from '../../infrastructure/llm/llm.errors.js';
import type {
  AiRequestRecord,
  AiRequestRepository
} from './normalization-ai-requests.repository.js';
import {
  AI_MATCHING_PROMPT_VERSION,
  type AiMatcher,
  type AiMatchingResult
} from './normalization.ai.js';
import { type DictionaryTerm, toMatchKey } from './normalization.matching.js';
import type { AiDictionary, DecisionStore } from './normalization.repository.js';

export const MAX_AI_ATTEMPTS = 3;
const RETRY_DELAY_MILLISECONDS = 30_000;

// Provider failures that may pass with time; others fail the request at once.
const RETRYABLE_CATEGORIES = new Set<LlmErrorCategory>([
  'rate_limited',
  'timeout',
  'provider_unavailable'
]);

export type AiRequestOutcome =
  | 'matched'
  | 'unmatched'
  // The claim's value changed, or it was linked meanwhile; nothing written.
  | 'superseded'
  // Another worker claimed the request after this lease expired.
  | 'stale'
  | 'retrying'
  | 'failed';

export interface AiRequestProcessor {
  process(request: AiRequestRecord): Promise<AiRequestOutcome>;
}

export interface AiRequestProcessorDependencies {
  dictionary: AiDictionary;
  decisions: Pick<DecisionStore, 'saveDecision' | 'findLatestDecision'>;
  requests: Pick<AiRequestRepository, 'lockClaimed' | 'complete' | 'supersede' | 'retry' | 'fail'>;
  matcher: AiMatcher;
  unitOfWork: UnitOfWork;
}

// Offers the terms spelling matching found equally close first, then the rest.
function orderTerms(terms: DictionaryTerm[], preferredIds: string[]): DictionaryTerm[] {
  const preferred = preferredIds
    .map((termId) => terms.find((term) => term.termId === termId))
    .filter((term): term is DictionaryTerm => term !== undefined);
  return [...preferred, ...terms.filter((term) => !preferredIds.includes(term.termId))];
}

export function createAiRequestProcessor({
  dictionary,
  decisions,
  requests,
  matcher,
  unitOfWork
}: AiRequestProcessorDependencies): AiRequestProcessor {
  // The AI is asked only once per spelling: a pending AI alias answers again.
  async function findMatch(request: AiRequestRecord): Promise<AiMatchingResult> {
    const matchKey = toMatchKey(request.originalValue);
    const proposed = await dictionary.findAiProposedTerm(request.category, matchKey);
    if (proposed) {
      return {
        status: 'matched',
        term: proposed,
        confidence: 1,
        reason: 'Reused an earlier AI match for the same value'
      };
    }

    const terms = await dictionary.listActiveTerms(request.category);
    return matcher.match({
      operationId: request.claimId,
      category: request.category,
      value: request.originalValue,
      context: request.context,
      terms: orderTerms(terms, request.preferredTermIds)
    });
  }

  // Only provider failures enter the retry policy. Any other error, such as a
  // database or programming error, is thrown with its real cause; the request
  // is then claimed again after its lease, until the attempt limit fails it.
  async function handleFailure(
    request: AiRequestRecord,
    error: unknown
  ): Promise<AiRequestOutcome> {
    if (!(error instanceof LlmError)) {
      throw error;
    }
    const category: LlmErrorCategory = error.category;
    if (RETRYABLE_CATEGORIES.has(category) && request.attemptCount < MAX_AI_ATTEMPTS) {
      const retried = await requests.retry(
        request,
        category,
        RETRY_DELAY_MILLISECONDS * request.attemptCount
      );
      return retried ? 'retrying' : 'stale';
    }
    return (await requests.fail(request, category)) ? 'failed' : 'stale';
  }

  return {
    async process(request) {
      // Every claim adds an attempt, including claims after an unexpected
      // error or a crashed worker, which never reach the retry policy.
      if (request.attemptCount > MAX_AI_ATTEMPTS) {
        return (await requests.fail(request, 'max_attempts_exceeded')) ? 'failed' : 'stale';
      }

      let result: AiMatchingResult;
      try {
        result = await findMatch(request);
      } catch (error) {
        return handleFailure(request, error);
      }

      if (result.status === 'invalid') {
        return (await requests.fail(request, 'invalid_output')) ? 'failed' : 'stale';
      }

      return unitOfWork.run(async (transaction): Promise<AiRequestOutcome> => {
        if (!(await requests.lockClaimed(request, transaction))) {
          return 'stale';
        }

        // The request is only valid while the claim still has this value and
        // nothing else linked it.
        const latest = await decisions.findLatestDecision(request.claimId, transaction);
        if (latest?.originalValue !== request.originalValue || latest.status === 'matched') {
          await requests.supersede(request, transaction);
          return 'superseded';
        }

        const term = result.status === 'matched' ? result.term : null;
        await decisions.saveDecision(
          {
            claimId: request.claimId,
            originalValue: request.originalValue,
            termId: term?.termId ?? null,
            method: 'ai',
            confidenceScore: result.status === 'matched' ? result.confidence : null,
            actorType: 'ai',
            ruleVersion: AI_MATCHING_PROMPT_VERSION,
            status: term ? 'matched' : 'unmatched'
          },
          transaction
        );
        if (term) {
          await dictionary.proposeAiAlias(
            term.termId,
            request.originalValue.trim(),
            toMatchKey(request.originalValue),
            transaction
          );
        }
        await requests.complete(request, transaction);
        return term ? 'matched' : 'unmatched';
      });
    }
  };
}
