import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../testing/create-test-app.js';
import {
  CreateNormalizationDecisionInput,
  DecisionStore,
  NormalizationDecisionRecord
} from './normalization.repository.js';
import { SEED_DICTIONARY } from './normalization.seed-data.js';
import { DictionaryWriter, seedDictionary } from './normalization.seed.js';
import { claimContext, createNormalizationService } from './normalization.service.js';
import {
  CanonicalCategory,
  DictionaryLookup,
  DictionaryTerm,
  matchTerm,
  toMatchKey
} from './normalization.matching.js';
import {
  aliases,
  aliasScope,
  aliasStatus,
  canonicalCategory,
  canonicalTerms,
  normalizationDecisions,
  normalizationMethod,
  normalizationStatus
} from './normalization.table.js';

function indexNamed(table: Parameters<typeof getTableConfig>[0], name: string) {
  return getTableConfig(table).indexes.find((index) => index.config.name === name);
}

function foreignKeyTo(table: Parameters<typeof getTableConfig>[0], target: string) {
  return getTableConfig(table).foreignKeys.find(
    (foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name === target
  );
}

describe('normalization tables', () => {
  it('normalizes skills, job titles, and degrees', () => {
    expect(canonicalCategory.enumValues).toEqual(['skill', 'job_title', 'degree']);
  });

  it('defines the later matching steps without using them yet', () => {
    expect(normalizationMethod.enumValues).toEqual([
      'canonical',
      'alias',
      'fuzzy',
      'ai',
      'candidate'
    ]);
    expect(normalizationStatus.enumValues).toEqual(['matched', 'unmatched', 'ambiguous']);
    expect(aliasScope.enumValues).toEqual(['global', 'candidate']);
    expect(aliasStatus.enumValues).toEqual(['pending', 'approved', 'rejected']);
  });

  it('keeps one canonical term per category and match key', () => {
    const unique = indexNamed(canonicalTerms, 'canonical_terms_category_match_key_unique');

    expect(unique?.config.unique).toBe(true);
    expect(foreignKeyTo(canonicalTerms, 'canonical_terms')?.onDelete).toBe('set null');
  });

  it('keeps each alias once per term and finds aliases by match key', () => {
    expect(indexNamed(aliases, 'aliases_term_id_match_key_unique')?.config.unique).toBe(true);
    expect(indexNamed(aliases, 'aliases_match_key_idx')).toBeDefined();
    expect(foreignKeyTo(aliases, 'canonical_terms')?.onDelete).toBe('cascade');
  });

  it('deletes decisions with their claim and keeps them when a term is removed', () => {
    expect(foreignKeyTo(normalizationDecisions, 'claims')?.onDelete).toBe('cascade');
    expect(foreignKeyTo(normalizationDecisions, 'canonical_terms')?.onDelete).toBe('set null');
    expect(
      indexNamed(normalizationDecisions, 'normalization_decisions_claim_id_idx')
    ).toBeDefined();
  });
});

function term(
  termId: string,
  category: CanonicalCategory,
  canonicalName: string,
  mergedIntoId: string | null = null
): DictionaryTerm {
  return {
    termId,
    category,
    canonicalName,
    status: mergedIntoId ? 'merged' : 'active',
    mergedIntoId
  };
}

// An in-memory dictionary with the same lookups as the repository. Aliases
// are approved and global unless marked otherwise.
function dictionary(
  terms: DictionaryTerm[],
  aliasList: { termId: string; text: string; approved?: boolean }[] = []
): DictionaryLookup {
  return {
    async findTermByMatchKey(category, matchKey) {
      return (
        terms.find(
          (item) => item.category === category && toMatchKey(item.canonicalName) === matchKey
        ) ?? null
      );
    },
    async findTermsByApprovedAlias(category, matchKey) {
      return aliasList
        .filter((alias) => alias.approved !== false && toMatchKey(alias.text) === matchKey)
        .map((alias) => terms.find((item) => item.termId === alias.termId))
        .filter((item): item is DictionaryTerm => item?.category === category);
    },
    async findTermById(termId) {
      return terms.find((item) => item.termId === termId) ?? null;
    },
    async listDictionaryEntries(category) {
      const names = terms
        .filter((item) => item.category === category)
        .map((item) => ({ matchKey: toMatchKey(item.canonicalName), term: item }));
      const approved = aliasList
        .filter((alias) => alias.approved !== false)
        .flatMap((alias) => {
          const owner = terms.find((item) => item.termId === alias.termId);
          return owner?.category === category
            ? [{ matchKey: toMatchKey(alias.text), term: owner }]
            : [];
        });
      return [...names, ...approved];
    }
  };
}

const javascript = term('t-js', 'skill', 'JavaScript');
const java = term('t-java', 'skill', 'Java');
const bachelor = term('t-bsc', 'degree', 'Bachelor of Science');

describe('match keys', () => {
  it('ignores case and extra spaces but keeps punctuation', () => {
    expect(toMatchKey('  Back End   Developer ')).toBe('back end developer');
    expect(toMatchKey('ＪａｖａＳｃｒｉｐｔ')).toBe('javascript');
    expect(new Set(['C', 'C#', 'C++'].map(toMatchKey)).size).toBe(3);
  });
});

describe('term matching', () => {
  it('matches a canonical term first', async () => {
    const lookup = dictionary([javascript], [{ termId: 't-java', text: 'JavaScript' }]);

    expect(await matchTerm(lookup, 'skill', ' javascript ')).toEqual({
      status: 'matched',
      method: 'canonical',
      term: javascript,
      confidence: 1
    });
  });

  it('matches an approved alias when no canonical term matches', async () => {
    const lookup = dictionary([javascript], [{ termId: 't-js', text: 'JS' }]);

    expect(await matchTerm(lookup, 'skill', 'js')).toEqual({
      status: 'matched',
      method: 'alias',
      term: javascript,
      confidence: 1
    });
  });

  it('ignores aliases that are not approved', async () => {
    const lookup = dictionary([javascript], [{ termId: 't-js', text: 'JS', approved: false }]);

    expect(await matchTerm(lookup, 'skill', 'JS')).toEqual({ status: 'unmatched' });
  });

  it('leaves a value unmatched when nothing matches or it is empty', async () => {
    const lookup = dictionary([javascript]);

    expect(await matchTerm(lookup, 'skill', 'Kotlin')).toEqual({ status: 'unmatched' });
    expect(await matchTerm(lookup, 'skill', '   ')).toEqual({ status: 'unmatched' });
  });

  it('matches only within the same category', async () => {
    const lookup = dictionary([bachelor], [{ termId: 't-bsc', text: 'BSc' }]);

    expect(await matchTerm(lookup, 'skill', 'Bachelor of Science')).toEqual({
      status: 'unmatched'
    });
    expect(await matchTerm(lookup, 'degree', 'B S C')).toEqual({ status: 'unmatched' });
    expect(await matchTerm(lookup, 'degree', 'bsc')).toMatchObject({ status: 'matched' });
  });

  it('leaves an alias that leads to more than one term ambiguous', async () => {
    const lookup = dictionary(
      [javascript, java],
      [
        { termId: 't-js', text: 'J' },
        { termId: 't-java', text: 'J' }
      ]
    );

    expect(await matchTerm(lookup, 'skill', 'J')).toEqual({
      status: 'ambiguous',
      method: 'alias',
      terms: [javascript, java]
    });
  });

  it('follows a merged term to the term it was merged into', async () => {
    const ecmascript = term('t-es', 'skill', 'ECMAScript', 't-js');
    const lookup = dictionary([javascript, ecmascript], [{ termId: 't-es', text: 'ES' }]);

    expect(await matchTerm(lookup, 'skill', 'ECMAScript')).toMatchObject({
      method: 'canonical',
      term: javascript
    });
    expect(await matchTerm(lookup, 'skill', 'ES')).toMatchObject({
      method: 'alias',
      term: javascript
    });
  });

  it('treats aliases of merged terms that lead to one term as one match', async () => {
    const ecmascript = term('t-es', 'skill', 'ECMAScript', 't-js');
    const lookup = dictionary(
      [javascript, ecmascript],
      [
        { termId: 't-js', text: 'JS' },
        { termId: 't-es', text: 'JS' }
      ]
    );

    expect(await matchTerm(lookup, 'skill', 'JS')).toMatchObject({
      status: 'matched',
      term: javascript
    });
  });

  it('corrects spelling after exact and alias matching fail', async () => {
    const python = term('t-py', 'skill', 'Python');
    const lookup = dictionary([python, javascript]);

    expect(await matchTerm(lookup, 'skill', 'Pyhton')).toEqual({
      status: 'matched',
      method: 'fuzzy',
      term: python,
      confidence: 0.83
    });
  });

  it('corrects spelling against approved aliases only', async () => {
    const postgresql = term('t-pg', 'skill', 'PostgreSQL');

    expect(
      await matchTerm(
        dictionary([postgresql], [{ termId: 't-pg', text: 'Postgres' }]),
        'skill',
        'Postgress'
      )
    ).toMatchObject({ status: 'matched', method: 'fuzzy', term: postgresql });
    expect(
      await matchTerm(
        dictionary([postgresql], [{ termId: 't-pg', text: 'Postgres', approved: false }]),
        'skill',
        'Postgress'
      )
    ).toEqual({ status: 'unmatched' });
  });

  it('prefers an exact match over a spelling correction', async () => {
    const reactNative = term('t-rn', 'skill', 'React Native');
    const lookup = dictionary([reactNative], [{ termId: 't-rn', text: 'ReactNative' }]);

    expect(await matchTerm(lookup, 'skill', 'reactnative')).toMatchObject({
      method: 'alias',
      confidence: 1
    });
  });

  it('corrects spelling only within the same category', async () => {
    const lookup = dictionary([term('t-se', 'job_title', 'Software Engineer')]);

    expect(await matchTerm(lookup, 'skill', 'Sofware Enginer')).toEqual({
      status: 'unmatched'
    });
    expect(await matchTerm(lookup, 'job_title', 'Sofware Enginer')).toMatchObject({
      status: 'matched',
      method: 'fuzzy'
    });
  });

  it('corrects to the term a merged spelling was merged into', async () => {
    const kubernetes = term('t-k8s', 'skill', 'Kubernetes');
    const oldName = term('t-old', 'skill', 'Kubernetes Engine', 't-k8s');
    const lookup = dictionary([kubernetes, oldName]);

    expect(await matchTerm(lookup, 'skill', 'Kubernetes Engne')).toMatchObject({
      status: 'matched',
      method: 'fuzzy',
      term: kubernetes
    });
  });

  it('leaves a value between two close terms ambiguous', async () => {
    const project = term('t-pjm', 'job_title', 'Project Manager');
    const product = term('t-pdm', 'job_title', 'Product Manager');

    expect(
      await matchTerm(dictionary([project, product]), 'job_title', 'Prodject Manager')
    ).toEqual({ status: 'ambiguous', method: 'fuzzy', terms: [project, product] });
  });

  it('finds no term through a broken or circular merge', async () => {
    const lookup = dictionary([
      term('t-a', 'skill', 'Alpha', 't-b'),
      term('t-b', 'skill', 'Beta', 't-a'),
      term('t-c', 'skill', 'Gamma', 't-missing')
    ]);

    expect(await matchTerm(lookup, 'skill', 'Alpha')).toEqual({ status: 'unmatched' });
    expect(await matchTerm(lookup, 'skill', 'Gamma')).toEqual({ status: 'unmatched' });
  });
});

// The dictionary lookups plus decisions kept in memory, newest last.
function repositoryWith(lookup: DictionaryLookup): DictionaryLookup &
  DecisionStore & { decisions: NormalizationDecisionRecord[] } {
  const decisions: NormalizationDecisionRecord[] = [];
  return {
    ...lookup,
    decisions,
    async saveDecision(input: CreateNormalizationDecisionInput) {
      const decision: NormalizationDecisionRecord = {
        normalizationId: `n-${decisions.length + 1}`,
        claimId: input.claimId,
        termId: input.termId ?? null,
        originalValue: input.originalValue,
        method: input.method ?? null,
        confidenceScore: input.confidenceScore ?? null,
        actorType: input.actorType,
        ruleVersion: input.ruleVersion,
        status: input.status,
        createdAt: new Date()
      };
      decisions.push(decision);
      return decision;
    },
    async findLatestDecision(claimId) {
      return decisions.filter((decision) => decision.claimId === claimId).at(-1) ?? null;
    }
  };
}

const softwareEngineer = term('t-se', 'job_title', 'Software Engineer');

function serviceWith() {
  const repository = repositoryWith(
    dictionary(
      [javascript, java, softwareEngineer, bachelor],
      [
        { termId: 't-js', text: 'JS' },
        { termId: 't-bsc', text: 'BSc' },
        { termId: 't-js', text: 'J' },
        { termId: 't-java', text: 'J' }
      ]
    )
  );
  return { repository, service: createNormalizationService({ repository }) };
}

describe('AI requests', () => {
  function serviceWithAi() {
    const { repository } = serviceWith();
    const aiRequests = { enqueue: vi.fn().mockResolvedValue({}) };
    return {
      repository,
      aiRequests,
      service: createNormalizationService({ repository, aiRequests })
    };
  }

  it('asks the AI about a value exact and spelling matching left unmatched', async () => {
    const { service, aiRequests, repository } = serviceWithAi();

    const decision = await service.normalizeClaim({
      claimId: 'c-1',
      claimType: 'employment',
      values: {
        employer: 'Aramex',
        jobTitle: 'Server-side Engineer',
        startDate: '2021-03',
        skills: ['Node.js', 'SQL']
      }
    });

    expect(decision).toMatchObject({ status: 'unmatched' });
    expect(repository.decisions).toHaveLength(1);
    expect(aiRequests.enqueue).toHaveBeenCalledWith({
      claimId: 'c-1',
      category: 'job_title',
      originalValue: 'Server-side Engineer',
      context: { employer: 'Aramex', startDate: '2021-03', skills: 'Node.js, SQL' },
      preferredTermIds: []
    });
  });

  it('offers the AI the terms an ambiguous value could mean', async () => {
    const { service, aiRequests } = serviceWithAi();

    await service.normalizeClaim({ claimId: 'c-1', claimType: 'skill', values: { name: 'J' } });

    expect(aiRequests.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTermIds: ['t-js', 't-java'] })
    );
  });

  it('does not ask the AI about matched or unchanged values', async () => {
    const { service, aiRequests } = serviceWithAi();
    const claim = { claimId: 'c-1', claimType: 'skill', values: { name: 'Rustacean' } };

    await service.normalizeClaim({ ...claim, values: { name: 'JS' } });
    expect(aiRequests.enqueue).not.toHaveBeenCalled();

    await service.normalizeClaim({ ...claim, claimId: 'c-2' });
    await service.normalizeClaim({ ...claim, claimId: 'c-2' });
    expect(aiRequests.enqueue).toHaveBeenCalledOnce();
  });

  it('keeps long context short', () => {
    expect(claimContext({ name: 'Go', description: 'x'.repeat(500) }, 'name')).toEqual({
      description: 'x'.repeat(300)
    });
  });
});

describe('claim normalization', () => {
  it('stores a decision that links the value to its canonical term', async () => {
    const { repository, service } = serviceWith();

    const decision = await service.normalizeClaim({
      claimId: 'c-1',
      claimType: 'skill',
      values: { name: 'JS' }
    });

    expect(decision).toMatchObject({
      claimId: 'c-1',
      termId: 't-js',
      originalValue: 'JS',
      method: 'alias',
      confidenceScore: 1,
      actorType: 'system',
      ruleVersion: 'fuzzy-v1',
      status: 'matched'
    });
    expect(repository.decisions).toHaveLength(1);
  });

  it('normalizes job titles and degrees in their own categories', async () => {
    const { service } = serviceWith();

    const job = await service.normalizeClaim({
      claimId: 'c-2',
      claimType: 'employment',
      values: { jobTitle: 'software engineer', employer: 'Example Corp', startDate: '2021-03' }
    });
    const degree = await service.normalizeClaim({
      claimId: 'c-3',
      claimType: 'education',
      values: { institution: 'Sample University', degree: 'BSc', startDate: '2019-09' }
    });

    expect(job).toMatchObject({
      termId: 't-se',
      method: 'canonical',
      originalValue: 'software engineer'
    });
    expect(degree).toMatchObject({ termId: 't-bsc', method: 'alias' });
  });

  it('records unmatched and ambiguous values without a term', async () => {
    const { service } = serviceWith();

    const unmatched = await service.normalizeClaim({
      claimId: 'c-4',
      claimType: 'skill',
      values: { name: 'Kotlin' }
    });
    const ambiguous = await service.normalizeClaim({
      claimId: 'c-5',
      claimType: 'skill',
      values: { name: 'J' }
    });

    expect(unmatched).toMatchObject({
      status: 'unmatched',
      termId: null,
      method: null,
      confidenceScore: null
    });
    expect(ambiguous).toMatchObject({
      status: 'ambiguous',
      termId: null,
      method: 'alias',
      confidenceScore: null
    });
  });

  it('does not normalize claim types without a normalized value', async () => {
    const { repository, service } = serviceWith();

    const decision = await service.normalizeClaim({
      claimId: 'c-6',
      claimType: 'language',
      values: { name: 'English' }
    });

    expect(decision).toBeNull();
    expect(repository.decisions).toEqual([]);
  });

  it('keeps the decision for an unchanged value and adds history for a change', async () => {
    const { repository, service } = serviceWith();
    const claim = { claimId: 'c-7', claimType: 'skill', values: { name: 'JS' } };

    const first = await service.normalizeClaim(claim);
    const again = await service.normalizeClaim(claim);
    const changed = await service.normalizeClaim({ ...claim, values: { name: 'Java' } });

    expect(again).toBe(first);
    expect(changed).toMatchObject({ termId: 't-java', originalValue: 'Java' });
    expect(repository.decisions.map((decision) => decision.originalValue)).toEqual([
      'JS',
      'Java'
    ]);
  });
});

describe('normalization module', () => {
  it('shares the normalization service with other modules', async () => {
    const app = await createTestApp();
    try {
      await app.ready();
      expect(app.hasDecorator('normalizationService')).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('starting dictionary', () => {
  const categories = Object.entries(SEED_DICTIONARY) as [
    CanonicalCategory,
    typeof SEED_DICTIONARY.skill
  ][];

  it('writes each term once per category', () => {
    for (const [category, terms] of categories) {
      const keys = terms.map((item) => toMatchKey(item.name));
      expect(new Set(keys).size, category).toBe(keys.length);
    }
  });

  it('never gives one alias to two terms, or an alias that is another term', () => {
    for (const [category, terms] of categories) {
      const termKeys = new Set(terms.map((item) => toMatchKey(item.name)));
      const aliasKeys = terms.flatMap((item) => item.aliases.map(toMatchKey));

      expect(new Set(aliasKeys).size, category).toBe(aliasKeys.length);
      for (const key of aliasKeys) {
        expect(termKeys.has(key), `${category}: ${key}`).toBe(false);
      }
    }
  });
});

// An in-memory store that keeps seeded rows and answers lookups like the
// repository.
function seededStore(): DictionaryWriter & DictionaryLookup & { aliasCount(): number } {
  const terms: DictionaryTerm[] = [];
  const aliasRows: { termId: string; matchKey: string }[] = [];
  return {
    async ensureTerm(category, canonicalName, matchKey) {
      const existing = terms.find(
        (item) => item.category === category && toMatchKey(item.canonicalName) === matchKey
      );
      if (existing) {
        return { termId: existing.termId, created: false };
      }
      const created = term(`t-${terms.length + 1}`, category, canonicalName);
      terms.push(created);
      return { termId: created.termId, created: true };
    },
    async ensureAlias(termId, _aliasText, matchKey) {
      if (aliasRows.some((row) => row.termId === termId && row.matchKey === matchKey)) {
        return false;
      }
      aliasRows.push({ termId, matchKey });
      return true;
    },
    async findTermByMatchKey(category, matchKey) {
      return (
        terms.find(
          (item) => item.category === category && toMatchKey(item.canonicalName) === matchKey
        ) ?? null
      );
    },
    async findTermsByApprovedAlias(category, matchKey) {
      return aliasRows
        .filter((row) => row.matchKey === matchKey)
        .map((row) => terms.find((item) => item.termId === row.termId))
        .filter((item): item is DictionaryTerm => item?.category === category);
    },
    async findTermById(termId) {
      return terms.find((item) => item.termId === termId) ?? null;
    },
    async listDictionaryEntries(category) {
      const names = terms
        .filter((item) => item.category === category)
        .map((item) => ({ matchKey: toMatchKey(item.canonicalName), term: item }));
      const aliasEntries = aliasRows.flatMap((row) => {
        const owner = terms.find((item) => item.termId === row.termId);
        return owner?.category === category ? [{ matchKey: row.matchKey, term: owner }] : [];
      });
      return [...names, ...aliasEntries];
    },
    aliasCount: () => aliasRows.length
  };
}

describe('dictionary seeding', () => {
  it('adds every term and alias, and adds nothing when run again', async () => {
    const store = seededStore();
    const termTotal = Object.values(SEED_DICTIONARY).flat().length;
    const aliasTotal = Object.values(SEED_DICTIONARY)
      .flat()
      .reduce((total, item) => total + item.aliases.length, 0);

    expect(await seedDictionary(store)).toEqual({
      termsAdded: termTotal,
      aliasesAdded: aliasTotal
    });
    expect(await seedDictionary(store)).toEqual({ termsAdded: 0, aliasesAdded: 0 });
    expect(store.aliasCount()).toBe(aliasTotal);
  });

  it.each([
    ['skill', 'js', 'JavaScript'],
    ['skill', 'Postgres', 'PostgreSQL'],
    ['skill', 'C#', 'C#'],
    ['job_title', 'Back-end Developer', 'Backend Developer'],
    ['degree', 'B.Sc.', 'Bachelor of Science'],
    ['skill', 'Javascirpt', 'JavaScript'],
    ['job_title', 'Sofware Enginer', 'Software Engineer']
  ] as const)('matches %s "%s" to "%s" after seeding', async (category, value, expected) => {
    const store = seededStore();
    await seedDictionary(store);

    const result = await matchTerm(store, category, value);

    expect(result.status).toBe('matched');
    expect(result.status === 'matched' && result.term.canonicalName).toBe(expected);
  });
});
