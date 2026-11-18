import { describe, expect, it } from 'vitest';
import {
  compareClaimFields,
  compareClaimIdentity
} from '../../modules/candidates/candidates.claim-comparison.js';
import { prepareUnknownClaimValues } from '../../modules/candidates/candidates.claim-values.js';
import { matchTerm, toMatchKey } from '../../modules/normalization/normalization.matching.js';
import { SEED_DICTIONARY } from '../../modules/normalization/normalization.seed-data.js';
import { DEMO_ACCOUNTS, DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, type DemoClaim } from './demo-data.js';

const claims: DemoClaim[] = DEMO_ACCOUNTS.flatMap((account) => account.claims ?? []);

describe('demo data', () => {
  it('uses only the reserved demo email domain', () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(account.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`)).toBe(true);
    }
    expect(DEMO_EMAIL_DOMAIN.endsWith('.test')).toBe(true);
  });

  it('has unique emails and an account for every role', () => {
    expect(new Set(DEMO_ACCOUNTS.map((account) => account.email)).size).toBe(
      DEMO_ACCOUNTS.length
    );
    expect(new Set(DEMO_ACCOUNTS.map((account) => account.role))).toEqual(
      new Set(['candidate', 'reviewer', 'admin'])
    );
  });

  it('gives profiles and claims to candidates only', () => {
    for (const account of DEMO_ACCOUNTS) {
      const isCandidate = account.role === 'candidate';
      expect(account.profile !== undefined).toBe(isCandidate);
      expect((account.claims ?? []).length > 0).toBe(isCandidate);
    }
  });

  it('has a password the API accepts', () => {
    expect(DEMO_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });

  it('has only claims the API accepts', () => {
    for (const { claim } of claims) {
      expect(() => prepareUnknownClaimValues(claim.type, claim.values)).not.toThrow();
    }
  });

  it('covers every claim type and status', () => {
    expect(new Set(claims.map(({ claim }) => claim.type))).toEqual(
      new Set(['skill', 'employment', 'education', 'certification', 'language', 'project'])
    );
    expect(new Set(claims.map(({ status }) => status))).toEqual(
      new Set(['accepted', 'pending', 'rejected'])
    );
  });

  it('gives Omar duplicate candidates of every claim type and every field outcome', () => {
    const omar = DEMO_ACCOUNTS.find(
      (account) => account.email === 'omar@demo.luminacv.test'
    )!;
    const claimTypes = [
      'skill',
      'employment',
      'education',
      'certification',
      'language',
      'project'
    ] as const;
    const fieldOutcomes = new Set<string>();

    for (const claimType of claimTypes) {
      const sameTypeClaims = (omar.claims ?? []).filter(
        ({ claim }) => claim.type === claimType
      );
      let foundDuplicate = false;

      for (let leftIndex = 0; leftIndex < sameTypeClaims.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < sameTypeClaims.length; rightIndex += 1) {
          const left = sameTypeClaims[leftIndex]!.claim;
          const right = sameTypeClaims[rightIndex]!.claim;
          const leftComparable = {
            candidateId: 'omar',
            claimType,
            values: left.values,
            current: false
          };
          const rightComparable = {
            candidateId: 'omar',
            claimType,
            values: right.values,
            current: false
          };
          const identity = compareClaimIdentity(leftComparable, rightComparable);
          if (identity.result !== 'equivalent' && identity.result !== 'suspected_duplicate') {
            continue;
          }

          foundDuplicate = true;
          const comparison = compareClaimFields(leftComparable, rightComparable);
          if (comparison.result === 'compared') {
            for (const outcome of Object.values(comparison.fields)) {
              fieldOutcomes.add(outcome.kind);
            }
          }
        }
      }

      expect(foundDuplicate, `missing ${claimType} duplicate`).toBe(true);
    }

    for (const outcome of [
      'same',
      'enrichment',
      'precision_improvement',
      'conflict'
    ]) {
      expect(fieldOutcomes).toContain(outcome);
    }
  });

  it('gives Omar review items for every claim type and extraction issue category', () => {
    const omar = DEMO_ACCOUNTS.find(
      (account) => account.email === 'omar@demo.luminacv.test'
    )!;
    const reviewItems = omar.document?.reviewItems ?? [];

    expect(new Set(reviewItems.map(({ claimType }) => claimType))).toEqual(
      new Set(['skill', 'employment', 'education', 'certification', 'language', 'project'])
    );
    expect(
      new Set(reviewItems.flatMap(({ issues }) => issues.map(({ code }) => code)))
    ).toEqual(
      new Set([
        'invalid_item',
        'invalid_source',
        'missing_job_title',
        'invalid_date',
        'missing_issue_date',
        'invalid_value',
        'missing_value',
        'invalid_date_order'
      ])
    );
  });

  it('gives a CV to every candidate with extracted claims, as extraction does', () => {
    for (const account of DEMO_ACCOUNTS) {
      if ((account.claims ?? []).some(({ origin }) => origin === 'extracted')) {
        expect(account.document).toBeDefined();
      }
    }
  });

  it('accepts manual claims, as the API does', () => {
    for (const { origin, status } of claims) {
      if (origin === 'manual') {
        expect(status).toBe('accepted');
      }
    }
  });

  it('shows every normalization step against the starting dictionary', async () => {
    const lookup = inMemoryDictionary();
    const categories = { skill: 'skill', employment: 'job_title', education: 'degree' } as const;
    const fields = { skill: 'name', employment: 'jobTitle', education: 'degree' } as const;
    const methods = new Set<string>();

    for (const { claim } of claims) {
      if (claim.type === 'skill' || claim.type === 'employment' || claim.type === 'education') {
        const value = (claim.values as Record<string, string>)[fields[claim.type]]!;
        const result = await matchTerm(lookup, categories[claim.type], value);
        methods.add(result.status === 'unmatched' ? 'unmatched' : `${result.status}:${result.method}`);
      }
    }

    expect(methods).toEqual(
      new Set([
        'matched:canonical',
        'matched:alias',
        'matched:fuzzy',
        'ambiguous:fuzzy',
        'unmatched'
      ])
    );
  });
});

// The starting dictionary as the repository would answer, in memory.
function inMemoryDictionary() {
  const terms = Object.entries(SEED_DICTIONARY).flatMap(([category, entries]) =>
    entries.map((entry) => ({
      termId: `${category}:${entry.name}`,
      category: category as keyof typeof SEED_DICTIONARY,
      canonicalName: entry.name,
      status: 'active' as const,
      mergedIntoId: null,
      aliases: entry.aliases
    }))
  );
  const spellings = terms.flatMap((term) =>
    [term.canonicalName, ...term.aliases].map((text, index) => ({
      matchKey: toMatchKey(text),
      term,
      isAlias: index > 0
    }))
  );

  return {
    async findTermByMatchKey(category: string, matchKey: string) {
      return (
        terms.find(
          (term) => term.category === category && toMatchKey(term.canonicalName) === matchKey
        ) ?? null
      );
    },
    async findTermsByApprovedAlias(category: string, matchKey: string) {
      return spellings
        .filter((spelling) => spelling.isAlias && spelling.matchKey === matchKey)
        .map((spelling) => spelling.term)
        .filter((term) => term.category === category);
    },
    async findTermById(termId: string) {
      return terms.find((term) => term.termId === termId) ?? null;
    },
    async listDictionaryEntries(category: string) {
      return spellings.filter((spelling) => spelling.term.category === category);
    }
  };
}
