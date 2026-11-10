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
}

// One value is normalized per claim type. Other types and fields, such as
// languages or the skills lists of jobs, are not normalized yet.
const NORMALIZED_VALUES: Record<string, { field: string; category: CanonicalCategory }> = {
  skill: { field: 'name', category: 'skill' },
  employment: { field: 'jobTitle', category: 'job_title' },
  education: { field: 'degree', category: 'degree' }
};

export function createNormalizationService({
  repository
}: NormalizationServiceDependencies): NormalizationService {
  return {
    async normalizeClaim(claim) {
      const target = NORMALIZED_VALUES[claim.claimType];
      const value = target ? claim.values[target.field] : undefined;
      if (!target || typeof value !== 'string') {
        return null;
      }

      // An unchanged value keeps its decision, so editing other fields does
      // not add history.
      const latest = await repository.findLatestDecision(claim.claimId);
      if (latest?.originalValue === value) {
        return latest;
      }

      const match = await matchTerm(repository, target.category, value);
      return repository.saveDecision({
        claimId: claim.claimId,
        originalValue: value,
        termId: match.status === 'matched' ? match.term.termId : null,
        method: match.status === 'unmatched' ? null : match.method,
        confidenceScore: match.status === 'matched' ? match.confidence : null,
        actorType: 'system',
        ruleVersion: MATCHING_RULE_VERSION,
        status: match.status
      });
    }
  };
}
