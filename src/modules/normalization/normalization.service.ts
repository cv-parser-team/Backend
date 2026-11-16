import type { AiRequestRepository } from './normalization-ai-requests.repository.js';
import {
  CanonicalCategory,
  DictionaryLookup,
  MATCHING_RULE_VERSION,
  matchTerm
} from './normalization.matching.js';
import { DecisionStore, NormalizationDecisionRecord } from './normalization.repository.js';

// The claim shape normalization needs; it matches the candidates module's
// claim records without depending on them.
export interface NormalizableClaim {
  claimId: string;
  claimType: string;
  values: Record<string, string | string[]>;
}

export interface NormalizationService {
  // Returns the claim's current decision, or null when its type has no
  // normalized value.
  normalizeClaim(claim: NormalizableClaim): Promise<NormalizationDecisionRecord | null>;
}

export interface NormalizationServiceDependencies {
  repository: DictionaryLookup & DecisionStore;
  // Absent when AI matching is disabled: values that exact and spelling
  // matching cannot link are then left for the candidate.
  aiRequests?: Pick<AiRequestRepository, 'enqueue'>;
}

// One value is normalized per claim type. Other types and fields, such as
// languages or the skills lists of jobs, are not normalized yet.
export const NORMALIZED_VALUES: Record<string, { field: string; category: CanonicalCategory }> = {
  skill: { field: 'name', category: 'skill' },
  employment: { field: 'jobTitle', category: 'job_title' },
  education: { field: 'degree', category: 'degree' }
};

// Longer context only costs tokens; the start of a description is enough to
// tell concepts apart.
const MAXIMUM_CONTEXT_LENGTH = 300;

// The claim's other fields, which help the AI tell apart concepts a value
// could mean, such as the employer of a job title.
export function claimContext(
  values: NormalizableClaim['values'],
  normalizedField: string
): Record<string, string> {
  const context: Record<string, string> = {};
  for (const [field, value] of Object.entries(values)) {
    if (field === normalizedField) {
      continue;
    }
    const text = (Array.isArray(value) ? value.join(', ') : value).trim();
    if (text) {
      context[field] = text.slice(0, MAXIMUM_CONTEXT_LENGTH);
    }
  }
  return context;
}

export function createNormalizationService({
  repository,
  aiRequests
}: NormalizationServiceDependencies): NormalizationService {
  return {
    async normalizeClaim(claim) {
      const target = NORMALIZED_VALUES[claim.claimType];
      const value = target ? claim.values[target.field] : undefined;
      if (!target || typeof value !== 'string') {
        return null;
      }

      // An unchanged value keeps its decision, so editing other fields does
      // not add history or ask the AI again.
      const latest = await repository.findLatestDecision(claim.claimId);
      if (latest?.originalValue === value) {
        return latest;
      }

      const match = await matchTerm(repository, target.category, value);
      const decision = await repository.saveDecision({
        claimId: claim.claimId,
        originalValue: value,
        termId: match.status === 'matched' ? match.term.termId : null,
        method: match.status === 'unmatched' ? null : match.method,
        confidenceScore: match.status === 'matched' ? match.confidence : null,
        actorType: 'system',
        ruleVersion: MATCHING_RULE_VERSION,
        status: match.status
      });

      // The AI runs in the background, so saving the claim never waits for it.
      if (match.status !== 'matched' && aiRequests) {
        await aiRequests.enqueue({
          claimId: claim.claimId,
          category: target.category,
          originalValue: value,
          context: claimContext(claim.values, target.field),
          preferredTermIds:
            match.status === 'ambiguous' ? match.terms.map((term) => term.termId) : []
        });
      }

      return decision;
    }
  };
}
