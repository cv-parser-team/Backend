import type { ClaimValues, CandidatesRepository, CreateClaimInput } from './candidates.repository.js';
import {
  compareClaimIdentity,
  type ComparableClaim
} from './candidates.claim-comparison.js';
import type { ExtractionTermLookup } from './candidates.extraction-writer.js';

// A fact that is not a claim yet, such as an extracted value awaiting review,
// identified by a key the caller chooses.
export interface UnsavedEntityInput {
  key: string;
  claimType: CreateClaimInput['claimType'];
  values: ClaimValues;
  current: boolean;
}

// The saved claims and the other unsaved facts that may state the same fact.
export interface SameEntityMatches {
  claimIds: string[];
  keys: string[];
}

export interface CandidateEntityMatcher {
  // Compares each fact with the candidate's active claims and with the other
  // facts, by the same identity rules that find duplicate claims. Facts with
  // no match are left out.
  findSameEntities(
    userId: string,
    facts: UnsavedEntityInput[]
  ): Promise<Map<string, SameEntityMatches>>;
}

export interface CandidateEntityMatcherDependencies {
  repository: Pick<CandidatesRepository, 'findCandidateByUserId' | 'listClaims'>;
  // Without it, values are compared as written.
  termLookup?: ExtractionTermLookup;
}

function isSameEntity(left: ComparableClaim, right: ComparableClaim): boolean {
  const identity = compareClaimIdentity(left, right);
  return identity.result === 'equivalent' || identity.result === 'suspected_duplicate';
}

export function createCandidateEntityMatcher({
  repository,
  termLookup
}: CandidateEntityMatcherDependencies): CandidateEntityMatcher {
  return {
    async findSameEntities(userId, facts) {
      const matches = new Map<string, SameEntityMatches>();
      if (facts.length === 0) {
        return matches;
      }
      const candidate = await repository.findCandidateByUserId(userId);
      if (!candidate) {
        return matches;
      }
      const claims = (await repository.listClaims(candidate.candidateId)).filter(
        (claim) => claim.status !== 'rejected' && claim.supersededByClaimId === null
      );

      let factTerms: (Record<string, string> | undefined)[] = [];
      let claimTerms = new Map<string, Record<string, string>>();
      if (termLookup) {
        try {
          [factTerms, claimTerms] = await Promise.all([
            termLookup.findDictionaryTerms(
              facts.map(({ claimType, values }) => ({ claimType, values }))
            ),
            termLookup.findNormalizedTerms(claims)
          ]);
        } catch {
          // Terms only refine the comparison; values are compared as written.
        }
      }

      const comparableClaims = claims.map((claim) => ({
        claimId: claim.claimId,
        comparable: {
          candidateId: candidate.candidateId,
          claimType: claim.claimType,
          values: claim.values,
          current: claim.current,
          ...(claimTerms.has(claim.claimId)
            ? { normalizedTerms: claimTerms.get(claim.claimId) }
            : {})
        } satisfies ComparableClaim
      }));
      const comparableFacts = facts.map((fact, index) => ({
        key: fact.key,
        comparable: {
          candidateId: candidate.candidateId,
          claimType: fact.claimType,
          values: fact.values,
          current: fact.current,
          ...(factTerms[index] ? { normalizedTerms: factTerms[index] } : {})
        } satisfies ComparableClaim
      }));

      for (const fact of comparableFacts) {
        const claimIds = comparableClaims
          .filter((claim) => isSameEntity(fact.comparable, claim.comparable))
          .map((claim) => claim.claimId);
        const keys = comparableFacts
          .filter(
            (other) => other.key !== fact.key && isSameEntity(fact.comparable, other.comparable)
          )
          .map((other) => other.key);
        if (claimIds.length > 0 || keys.length > 0) {
          matches.set(fact.key, { claimIds, keys });
        }
      }
      return matches;
    }
  };
}
