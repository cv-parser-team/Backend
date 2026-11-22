import type { AiRequestRepository } from './normalization-ai-requests.repository.js';
import {
  type CanonicalCategory,
  type DictionaryLookup,
  type DictionaryTerm,
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
  // The canonical term each claim's normalized value is linked to, by claim ID
  // and then by field, so claims written differently can be compared by
  // meaning. A decision made for an earlier value of the field is ignored.
  findNormalizedTerms(
    claims: NormalizableClaim[]
  ): Promise<Map<string, Record<string, string>>>;
  // The canonical name each claim's normalized value is shown as, by claim ID
  // and then by field, when it is written differently from the claim's own
  // value. The claim keeps its original value.
  describeNormalizedValues(
    claims: NormalizableClaim[]
  ): Promise<Map<string, Record<string, NormalizedValue>>>;
  // The dictionary term each value would be linked to, in input order, for
  // values that are not saved yet. It saves nothing and never asks the AI.
  findDictionaryTerms(
    claims: Pick<NormalizableClaim, 'claimType' | 'values'>[]
  ): Promise<(Record<string, string> | undefined)[]>;
}

export interface NormalizedValue {
  value: string;
  original: string;
  method: NonNullable<NormalizationDecisionRecord['method']>;
  confidence: number | null;
}

// A merge chain longer than this is treated as broken.
const MAXIMUM_MERGE_DEPTH = 10;

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
  // The current decision of each claim, when it links the claim's present
  // value to a term. A decision made for an earlier value is ignored.
  async function currentMatches(
    claims: NormalizableClaim[]
  ): Promise<{ claim: NormalizableClaim; field: string; decision: NormalizationDecisionRecord & { termId: string } }[]> {
    const normalizable = claims.filter(
      (claim) => NORMALIZED_VALUES[claim.claimType] !== undefined
    );
    const decisions = await repository.listLatestDecisions(
      normalizable.map((claim) => claim.claimId)
    );
    const decisionByClaim = new Map(decisions.map((decision) => [decision.claimId, decision]));

    return normalizable.flatMap((claim) => {
      const field = NORMALIZED_VALUES[claim.claimType]!.field;
      const decision = decisionByClaim.get(claim.claimId);
      return decision?.status === 'matched' &&
        decision.termId !== null &&
        decision.originalValue === claim.values[field]
        ? [{ claim, field, decision: { ...decision, termId: decision.termId } }]
        : [];
    });
  }

  // Follows merged terms to the active term they were merged into. A broken
  // or circular chain has no active term.
  async function activeTerms(termIds: string[]): Promise<Map<string, DictionaryTerm>> {
    const known = new Map<string, DictionaryTerm>();
    let missing = [...new Set(termIds)];
    for (let depth = 0; missing.length > 0 && depth <= MAXIMUM_MERGE_DEPTH; depth += 1) {
      for (const term of await repository.listTermsByIds(missing)) {
        known.set(term.termId, term);
      }
      missing = [...known.values()]
        .map((term) => term.mergedIntoId)
        .filter((id): id is string => id !== null && !known.has(id));
    }

    const active = new Map<string, DictionaryTerm>();
    for (const termId of termIds) {
      let term = known.get(termId);
      for (let depth = 0; term?.status === 'merged' && depth < MAXIMUM_MERGE_DEPTH; depth += 1) {
        term = term.mergedIntoId ? known.get(term.mergedIntoId) : undefined;
      }
      if (term?.status === 'active') {
        active.set(termId, term);
      }
    }
    return active;
  }

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
    },

    // Linked to the active term, so claims linked to two terms that were
    // merged compare as the same. A claim whose term has no active term is
    // compared by its written value instead.
    async findNormalizedTerms(claims) {
      const matches = await currentMatches(claims);
      const active = await activeTerms(matches.map(({ decision }) => decision.termId));
      const terms = new Map<string, Record<string, string>>();
      for (const { claim, field, decision } of matches) {
        const term = active.get(decision.termId);
        if (term) {
          terms.set(claim.claimId, { [field]: term.termId });
        }
      }
      return terms;
    },

    async describeNormalizedValues(claims) {
      const matches = await currentMatches(claims);
      const active = await activeTerms(matches.map(({ decision }) => decision.termId));
      const described = new Map<string, Record<string, NormalizedValue>>();

      for (const { claim, field, decision } of matches) {
        const name = active.get(decision.termId)?.canonicalName;
        if (name === undefined || name === decision.originalValue || decision.method === null) {
          continue;
        }
        described.set(claim.claimId, {
          [field]: {
            value: name,
            original: decision.originalValue,
            method: decision.method,
            confidence: decision.confidenceScore
          }
        });
      }
      return described;
    },

    async findDictionaryTerms(claims) {
      // Spelling correction lists a whole category; one listing serves every
      // value of that category.
      const entries = new Map<CanonicalCategory, ReturnType<DictionaryLookup['listDictionaryEntries']>>();
      const lookup: DictionaryLookup = {
        findTermByMatchKey: (category, matchKey) =>
          repository.findTermByMatchKey(category, matchKey),
        findTermsByApprovedAlias: (category, matchKey) =>
          repository.findTermsByApprovedAlias(category, matchKey),
        findTermById: (termId) => repository.findTermById(termId),
        listDictionaryEntries(category) {
          let listed = entries.get(category);
          if (!listed) {
            listed = repository.listDictionaryEntries(category);
            entries.set(category, listed);
          }
          return listed;
        }
      };

      const terms: (Record<string, string> | undefined)[] = [];
      for (const claim of claims) {
        const target = NORMALIZED_VALUES[claim.claimType];
        const value = target ? claim.values[target.field] : undefined;
        if (!target || typeof value !== 'string') {
          terms.push(undefined);
          continue;
        }
        const match = await matchTerm(lookup, target.category, value);
        terms.push(
          match.status === 'matched' ? { [target.field]: match.term.termId } : undefined
        );
      }
      return terms;
    }
  };
}
