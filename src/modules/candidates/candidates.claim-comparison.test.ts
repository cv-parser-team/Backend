import { describe, expect, it } from 'vitest';
import {
  buildAutomaticCoalescePlan,
  buildAutoAcceptMergePlan,
  buildClaimMergeProposal,
  buildConfirmedClaimMergePlan,
  compareClaimIdentity,
  compareClaimDateFieldValues,
  compareClaimDates,
  compareClaimFieldValues,
  compareClaimFields,
  compareClaims,
  selectClaimSurvivor,
  type ComparableClaim,
  type MergeCandidateClaim
} from './candidates.claim-comparison.js';

const candidateId = '11111111-1111-4111-8111-111111111111';

function claim(
  values: ComparableClaim['values'],
  overrides: Partial<ComparableClaim> = {}
): ComparableClaim {
  return {
    candidateId,
    claimType: 'employment',
    values,
    ...overrides
  };
}

function mergeCandidate(
  overrides: Partial<MergeCandidateClaim> = {}
): MergeCandidateClaim {
  return {
    claimId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    candidateId,
    claimType: 'skill',
    origin: 'extracted',
    status: 'pending',
    candidateEdited: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    values: { name: 'TypeScript' },
    ...overrides
  };
}

describe('strict claim comparison', () => {
  it('compares only claims from the same candidate and of the same type', () => {
    const values = { employer: 'Example Labs' };

    expect(
      compareClaims(
        claim(values),
        claim(values, { candidateId: '22222222-2222-4222-8222-222222222222' })
      )
    ).toEqual({ result: 'not_comparable', reason: 'different_candidate' });
    expect(
      compareClaims(claim(values), claim(values, { claimType: 'project' }))
    ).toEqual({ result: 'not_comparable', reason: 'different_type' });
  });

  it('ignores formatting, compatible Unicode, and array order or duplicates', () => {
    expect(
      compareClaims(
        claim({
          employer: '  EXAMPLE   LABS ',
          jobTitle: 'Ｂａｃｋｅｎｄ Engineer',
          skills: [' PostgreSQL ', 'TYPESCRIPT']
        }),
        claim({
          skills: ['typescript', 'postgresql', 'TypeScript'],
          jobTitle: 'backend engineer',
          employer: 'example labs'
        })
      )
    ).toEqual({ result: 'equivalent' });
  });

  it.each([
    [
      { employer: 'Example Labs' },
      { employer: 'Example Labs', location: 'Amman' }
    ],
    [{ employer: 'Example-Labs' }, { employer: 'Example Labs' }],
    [{ startDate: '2020' }, { startDate: '2020-03' }],
    [{ skills: ['TypeScript'] }, { skills: ['TypeScript', 'PostgreSQL'] }]
  ])('keeps meaningful value differences strict', (left, right) => {
    expect(compareClaims(claim(left), claim(right))).toEqual({
      result: 'different'
    });
  });
});

describe('claim identity comparison', () => {
  it.each(['skill', 'language'] as const)(
    'identifies formatting-equivalent %s names',
    (claimType) => {
      expect(
        compareClaimIdentity(
          claim({ name: '  ＴｙｐｅＳｃｒｉｐｔ ' }, { claimType }),
          claim({ name: 'typescript' }, { claimType })
        )
      ).toEqual({ result: 'equivalent' });
    }
  );

  it('keeps different or missing names distinct', () => {
    expect(
      compareClaimIdentity(
        claim({ name: 'TypeScript' }, { claimType: 'skill' }),
        claim({ name: 'JavaScript' }, { claimType: 'skill' })
      )
    ).toEqual({ result: 'different' });
    expect(
      compareClaimIdentity(
        claim({}, { claimType: 'language' }),
        claim({ name: 'English' }, { claimType: 'language' })
      )
    ).toEqual({ result: 'different' });
  });

  it('identifies certifications by title and issuer only', () => {
    expect(
      compareClaimIdentity(
        claim(
          {
            title: ' AWS   Solutions Architect ',
            issuer: 'Ａｍａｚｏｎ',
            issueDate: '2024'
          },
          { claimType: 'certification' }
        ),
        claim(
          {
            title: 'aws solutions architect',
            issuer: 'amazon',
            issueDate: '2024-03',
            credentialId: 'ABC-123'
          },
          { claimType: 'certification' }
        )
      )
    ).toEqual({ result: 'equivalent' });
  });

  it.each([
    [
      { title: 'AWS Solutions Architect', issuer: 'Amazon' },
      { title: 'AWS Developer', issuer: 'Amazon' }
    ],
    [
      { title: 'AWS Solutions Architect', issuer: 'Amazon' },
      { title: 'AWS Solutions Architect', issuer: 'Microsoft' }
    ],
    [
      { title: 'AWS Solutions Architect' },
      { title: 'AWS Solutions Architect', issuer: 'Amazon' }
    ]
  ])('keeps certifications with different identity fields distinct', (left, right) => {
    expect(
      compareClaimIdentity(
        claim(left, { claimType: 'certification' }),
        claim(right, { claimType: 'certification' })
      )
    ).toEqual({ result: 'different' });
  });

  it('compares only claims from the same candidate and type', () => {
    const skill = claim({ name: 'TypeScript' }, { claimType: 'skill' });

    expect(
      compareClaimIdentity(
        skill,
        claim(
          { name: 'TypeScript' },
          {
            candidateId: '22222222-2222-4222-8222-222222222222',
            claimType: 'skill'
          }
        )
      )
    ).toEqual({ result: 'not_comparable', reason: 'different_candidate' });
    expect(
      compareClaimIdentity(
        skill,
        claim({ name: 'TypeScript' }, { claimType: 'language' })
      )
    ).toEqual({ result: 'not_comparable', reason: 'different_type' });
  });

  it('identifies employment with matching identity and compatible dates', () => {
    expect(
      compareClaimIdentity(
        claim({
          employer: ' Example   Labs ',
          jobTitle: 'Ｂａｃｋｅｎｄ Engineer',
          startDate: '2020',
          endDate: '2024'
        }),
        claim({
          employer: 'example labs',
          jobTitle: 'backend engineer',
          startDate: '2020-03',
          endDate: '2024-06'
        })
      )
    ).toEqual({ result: 'equivalent' });
  });

  it('uses known Present context and tolerates a genuinely missing end date', () => {
    const ended = claim({
      employer: 'Example Labs',
      jobTitle: 'Backend Engineer',
      startDate: '2020-03',
      endDate: '2025'
    });

    expect(
      compareClaimIdentity(
        claim(
          {
            employer: 'Example Labs',
            jobTitle: 'Backend Engineer',
            startDate: '2020'
          },
          { current: true, currentAsOf: '2024-06' }
        ),
        ended
      )
    ).toEqual({ result: 'equivalent' });
    expect(
      compareClaimIdentity(
        claim({
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2020'
        }),
        ended
      )
    ).toEqual({ result: 'equivalent' });
  });

  it.each([
    [
      claim({
        employer: 'Example Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2020-03'
      }),
      claim({
        employer: 'Example Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2020-04'
      })
    ],
    [
      claim(
        {
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2020'
        },
        { current: true }
      ),
      claim({
        employer: 'Example Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2020',
        endDate: '2024-06'
      })
    ],
    [
      claim(
        {
          employer: 'Example Labs',
          jobTitle: 'Backend Engineer',
          startDate: '2020'
        },
        { current: true, currentAsOf: '2024-06' }
      ),
      claim({
        employer: 'Example Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2020',
        endDate: '2024-05'
      })
    ]
  ])('flags uncertain or conflicting employment dates', (left, right) => {
    expect(compareClaimIdentity(left, right)).toEqual({
      result: 'suspected_duplicate'
    });
  });

  it('keeps employment with different employer or title distinct', () => {
    const base = {
      employer: 'Example Labs',
      jobTitle: 'Backend Engineer',
      startDate: '2020'
    };

    expect(
      compareClaimIdentity(claim(base), claim({ ...base, employer: 'Other Labs' }))
    ).toEqual({ result: 'different' });
    expect(
      compareClaimIdentity(claim(base), claim({ ...base, jobTitle: 'Designer' }))
    ).toEqual({ result: 'different' });
  });

  it('identifies education with matching identity and compatible dates', () => {
    expect(
      compareClaimIdentity(
        claim(
          {
            institution: ' Example   University ',
            degree: 'ＢＳｃ Computer Science',
            fieldOfStudy: 'Computer Science',
            startDate: '2020',
            endDate: '2024'
          },
          { claimType: 'education' }
        ),
        claim(
          {
            institution: 'example university',
            degree: 'bsc computer science',
            startDate: '2020-09',
            endDate: '2024-06'
          },
          { claimType: 'education' }
        )
      )
    ).toEqual({ result: 'equivalent' });
  });

  it('flags conflicting education fields or dates as suspected duplicates', () => {
    const base = {
      institution: 'Example University',
      degree: 'BSc Computer Science',
      fieldOfStudy: 'Computer Science',
      startDate: '2020'
    };

    expect(
      compareClaimIdentity(
        claim(base, { claimType: 'education' }),
        claim(
          { ...base, fieldOfStudy: 'Software Engineering' },
          { claimType: 'education' }
        )
      )
    ).toEqual({ result: 'suspected_duplicate' });
    expect(
      compareClaimIdentity(
        claim(base, { claimType: 'education' }),
        claim({ ...base, startDate: '2021' }, { claimType: 'education' })
      )
    ).toEqual({ result: 'suspected_duplicate' });
    expect(
      compareClaimIdentity(
        claim(base, {
          claimType: 'education',
          current: true
        }),
        claim(
          { ...base, endDate: '2024' },
          { claimType: 'education' }
        )
      )
    ).toEqual({ result: 'suspected_duplicate' });
  });

  it('keeps education with a different institution or degree distinct', () => {
    const base = {
      institution: 'Example University',
      degree: 'BSc Computer Science',
      startDate: '2020'
    };

    expect(
      compareClaimIdentity(
        claim(base, { claimType: 'education' }),
        claim(
          { ...base, institution: 'Other University' },
          { claimType: 'education' }
        )
      )
    ).toEqual({ result: 'different' });
    expect(
      compareClaimIdentity(
        claim(base, { claimType: 'education' }),
        claim({ ...base, degree: 'MSc' }, { claimType: 'education' })
      )
    ).toEqual({ result: 'different' });
  });

  it('identifies projects with matching names and URLs', () => {
    expect(
      compareClaimIdentity(
        claim(
          {
            name: ' Shop   API ',
            url: ' https://example.com/shop ',
            role: 'Backend Engineer'
          },
          { claimType: 'project' }
        ),
        claim(
          {
            name: 'shop api',
            url: 'https://example.com/shop',
            description: 'An online store'
          },
          { claimType: 'project' }
        )
      )
    ).toEqual({ result: 'equivalent' });
  });

  it('flags matching project names with conflicting URLs', () => {
    expect(
      compareClaimIdentity(
        claim(
          { name: 'Shop API', url: 'https://example.com/one' },
          { claimType: 'project' }
        ),
        claim(
          { name: 'Shop API', url: 'https://example.com/two' },
          { claimType: 'project' }
        )
      )
    ).toEqual({ result: 'suspected_duplicate' });
  });

  it('uses compatible project dates when URL evidence is incomplete', () => {
    expect(
      compareClaimIdentity(
        claim(
          { name: 'Shop API', startDate: '2022', endDate: '2024' },
          { claimType: 'project' }
        ),
        claim(
          {
            name: 'Shop API',
            url: 'https://example.com/shop',
            startDate: '2022-03',
            endDate: '2024-06'
          },
          { claimType: 'project' }
        )
      )
    ).toEqual({ result: 'equivalent' });
  });

  it('flags projects with insufficient or conflicting date evidence', () => {
    expect(
      compareClaimIdentity(
        claim({ name: 'Shop API' }, { claimType: 'project' }),
        claim({ name: 'Shop API' }, { claimType: 'project' })
      )
    ).toEqual({ result: 'suspected_duplicate' });
    expect(
      compareClaimIdentity(
        claim(
          { name: 'Shop API', startDate: '2022' },
          { claimType: 'project', current: true }
        ),
        claim(
          { name: 'Shop API', startDate: '2022', endDate: '2024-05' },
          { claimType: 'project' }
        )
      )
    ).toEqual({ result: 'suspected_duplicate' });
  });

  it('keeps projects with different names distinct', () => {
    expect(
      compareClaimIdentity(
        claim({ name: 'Shop API' }, { claimType: 'project' }),
        claim({ name: 'Portfolio' }, { claimType: 'project' })
      )
    ).toEqual({ result: 'different' });
  });

  it('treats cosmetic differences in employer and title as the same identity', () => {
    const base = { jobTitle: 'Backend Engineer', startDate: '2022-01' };

    expect(
      compareClaimIdentity(
        claim({ ...base, employer: 'Northstar Labs' }),
        claim({ ...base, employer: 'Northstar Labs, Inc.' })
      )
    ).toEqual({ result: 'equivalent' });
    expect(
      compareClaimIdentity(
        claim({ employer: 'Northstar Labs', jobTitle: 'Sr. Backend Engineer', startDate: '2022' }),
        claim({ employer: 'Northstar Labs', jobTitle: 'Senior Backend Engineer', startDate: '2022' })
      )
    ).toEqual({ result: 'equivalent' });
  });

  it.each([
    ['Northstar Labs', 'Nortstar Labs'],
    ['International Business Machines', 'IBM']
  ])('asks the candidate to confirm employers %j and %j', (left, right) => {
    const base = { jobTitle: 'Backend Engineer', startDate: '2022-01' };

    expect(
      compareClaimIdentity(
        claim({ ...base, employer: left }),
        claim({ ...base, employer: right })
      )
    ).toEqual({ result: 'suspected_duplicate' });
  });

  it.each([
    ['UC Berkeley', 'University of California, Berkeley'],
    ['Univeristy of Jordan', 'University of Jordan'],
    ['MIT', 'Massachusetts Institute of Technology']
  ])('asks the candidate to confirm institutions %j and %j', (left, right) => {
    const base = { degree: 'Bachelor of Science', fieldOfStudy: 'Computer Science', endDate: '2020' };

    expect(
      compareClaimIdentity(
        claim({ ...base, institution: left }, { claimType: 'education' }),
        claim({ ...base, institution: right }, { claimType: 'education' })
      )
    ).toEqual({ result: 'suspected_duplicate' });
  });

  it('asks the candidate to confirm a shortened field of study', () => {
    const base = { institution: 'University of Jordan', degree: 'Bachelor of Science', endDate: '2020' };

    expect(
      compareClaimIdentity(
        claim({ ...base, fieldOfStudy: 'Comp. Science' }, { claimType: 'education' }),
        claim({ ...base, fieldOfStudy: 'Computer Science' }, { claimType: 'education' })
      )
    ).toEqual({ result: 'suspected_duplicate' });
  });

  it('keeps a degree from a different institution or of another level distinct', () => {
    const base = { degree: 'Bachelor of Science', fieldOfStudy: 'Computer Science', endDate: '2020' };

    expect(
      compareClaimIdentity(
        claim({ ...base, institution: 'Jordan University' }, { claimType: 'education' }),
        claim(
          { ...base, institution: 'Jordan University of Science and Technology' },
          { claimType: 'education' }
        )
      )
    ).toEqual({ result: 'different' });
    expect(
      compareClaimIdentity(
        claim({ ...base, institution: 'University of Jordan' }, { claimType: 'education' }),
        claim(
          { ...base, institution: 'University of Jordan', degree: 'Master of Science' },
          { claimType: 'education' }
        )
      )
    ).toEqual({ result: 'different' });
  });

  it('matches values linked to the same canonical term however they are written', () => {
    const education = {
      institution: 'University of Jordan',
      fieldOfStudy: 'Computer Science',
      startDate: '2016',
      endDate: '2020'
    };

    expect(
      compareClaimIdentity(
        claim({ ...education, degree: 'BSc' }, {
          claimType: 'education',
          normalizedTerms: { degree: 't-bsc' }
        }),
        claim({ ...education, degree: 'Bachelor of Science' }, {
          claimType: 'education',
          normalizedTerms: { degree: 't-bsc' }
        })
      )
    ).toEqual({ result: 'equivalent' });
    expect(
      compareClaimIdentity(
        claim({ name: 'JS' }, { claimType: 'skill', normalizedTerms: { name: 't-js' } }),
        claim({ name: 'JavaScript' }, { claimType: 'skill', normalizedTerms: { name: 't-js' } })
      )
    ).toEqual({ result: 'equivalent' });
    expect(
      compareClaimIdentity(
        claim(
          { employer: 'Northstar Labs', jobTitle: 'SWE', startDate: '2022' },
          { normalizedTerms: { jobTitle: 't-se' } }
        ),
        claim(
          { employer: 'Northstar Labs', jobTitle: 'Software Engineer', startDate: '2022' },
          { normalizedTerms: { jobTitle: 't-se' } }
        )
      )
    ).toEqual({ result: 'equivalent' });
  });

  it('does not ask the candidate to choose between spellings of one canonical term', () => {
    const proposal = buildClaimMergeProposal(
      mergeCandidate({ values: { name: 'Postgres' }, normalizedTerms: { name: 't-pg' } }),
      mergeCandidate({
        claimId: '22222222-2222-4222-8222-222222222222',
        values: { name: 'PostgreSQL' },
        normalizedTerms: { name: 't-pg' }
      })
    );

    expect(proposal).toMatchObject({
      result: 'proposal',
      identity: 'equivalent',
      fields: { name: { kind: 'same', value: 'Postgres' } },
      unresolvedFields: [],
      requiresCandidateChoice: false,
      recommendedAction: 'automatic_coalesce'
    });
  });

  it('keeps values linked to different terms, or to a term on one side only, distinct', () => {
    const education = { institution: 'University of Jordan', endDate: '2020' };

    expect(
      compareClaimIdentity(
        claim({ ...education, degree: 'BSc' }, {
          claimType: 'education',
          normalizedTerms: { degree: 't-bsc' }
        }),
        claim({ ...education, degree: 'MSc' }, {
          claimType: 'education',
          normalizedTerms: { degree: 't-msc' }
        })
      )
    ).toEqual({ result: 'different' });
    expect(
      compareClaimIdentity(
        claim({ name: 'JS' }, { claimType: 'skill', normalizedTerms: { name: 't-js' } }),
        claim({ name: 'JavaScript' }, { claimType: 'skill' })
      )
    ).toEqual({ result: 'different' });
  });

  it('keeps shared dates and the claim type in a proposal so a merge can use them', () => {
    const values = {
      degree: 'Bachelor of Science',
      startDate: '2016-05',
      endDate: '2020-05'
    };
    const proposal = buildClaimMergeProposal(
      mergeCandidate({
        claimType: 'education',
        values: { ...values, institution: 'UC Berkeley' }
      }),
      mergeCandidate({
        claimId: '22222222-2222-4222-8222-222222222222',
        claimType: 'education',
        values: { ...values, institution: 'University of California, Berkeley' }
      })
    );

    expect(proposal).toMatchObject({
      result: 'proposal',
      claimType: 'education',
      fields: {
        startDate: { kind: 'same', value: { kind: 'date', value: '2016-05' } },
        endDate: { kind: 'same', value: { kind: 'date', value: '2020-05' } }
      },
      proposedValues: { startDate: '2016-05', endDate: '2020-05' }
    });
  });

  it('proposes a merge that lets the candidate choose the institution spelling', () => {
    const values = { degree: 'Bachelor of Science', fieldOfStudy: 'Computer Science', endDate: '2020-05' };
    const proposal = buildClaimMergeProposal(
      mergeCandidate({
        claimType: 'education',
        values: { ...values, institution: 'UC Berkeley' }
      }),
      mergeCandidate({
        claimId: '22222222-2222-4222-8222-222222222222',
        claimType: 'education',
        values: { ...values, institution: 'University of California, Berkeley' }
      })
    );

    expect(proposal).toMatchObject({
      result: 'proposal',
      identity: 'suspected_duplicate',
      unresolvedFields: ['institution'],
      requiresCandidateChoice: true,
      recommendedAction: 'candidate_review'
    });
  });
});

describe('claim date comparison', () => {
  it.each([
    [{ kind: 'date', value: '2020' }, { kind: 'date', value: '2020' }, 'same'],
    [
      { kind: 'date', value: '2020-03' },
      { kind: 'date', value: '2020-03' },
      'same'
    ],
    [
      { kind: 'date', value: '2020' },
      { kind: 'date', value: '2020-03' },
      'precision_improvement'
    ],
    [
      { kind: 'date', value: '2020-03' },
      { kind: 'date', value: '2020-04' },
      'conflict'
    ],
    [
      { kind: 'date', value: '2020' },
      { kind: 'date', value: '2021-03' },
      'conflict'
    ],
    [{ kind: 'missing' }, { kind: 'date', value: '2020' }, 'missing']
  ] as const)('compares explicit partial dates', (left, right, expected) => {
    expect(compareClaimDates(left, right)).toBe(expected);
  });

  it('compares Present using its reliable source date', () => {
    expect(
      compareClaimDates(
        { kind: 'present', asOf: '2024-06' },
        { kind: 'date', value: '2024-06' }
      )
    ).toBe('compatible');
    expect(
      compareClaimDates(
        { kind: 'date', value: '2025' },
        { kind: 'present', asOf: '2024-06' }
      )
    ).toBe('compatible');
    expect(
      compareClaimDates(
        { kind: 'present', asOf: '2024-06' },
        { kind: 'date', value: '2024' }
      )
    ).toBe('compatible');
    expect(
      compareClaimDates(
        { kind: 'present', asOf: '2024-06' },
        { kind: 'date', value: '2024-05' }
      )
    ).toBe('conflict');
  });

  it('does not treat Present as conflicting when its source date is unknown', () => {
    expect(
      compareClaimDates(
        { kind: 'present' },
        { kind: 'date', value: '2020-03' }
      )
    ).toBe('uncertain');
  });

  it('recognizes two explicit Present values and rejects malformed dates', () => {
    expect(
      compareClaimDates({ kind: 'present' }, { kind: 'present', asOf: '2024-06' })
    ).toBe('same');
    expect(
      compareClaimDates(
        { kind: 'date', value: '2024-13' },
        { kind: 'date', value: '2024' }
      )
    ).toBe('invalid');
  });
});

describe('claim field comparison', () => {
  it('classifies missing values and one-sided enrichment', () => {
    expect(compareClaimFieldValues(undefined, undefined)).toEqual({
      kind: 'same'
    });
    expect(compareClaimFieldValues(undefined, 'Amman')).toEqual({
      kind: 'enrichment',
      value: 'Amman',
      from: 'right'
    });
    expect(compareClaimFieldValues('Amman', undefined)).toEqual({
      kind: 'enrichment',
      value: 'Amman',
      from: 'left'
    });
  });

  it('normalizes equivalent text and preserves meaningful conflicts', () => {
    expect(compareClaimFieldValues('  Ｂａｃｋｅｎｄ   Engineer ', 'backend engineer')).toEqual({
      kind: 'same',
      value: '  Ｂａｃｋｅｎｄ   Engineer '
    });
    expect(compareClaimFieldValues('Backend Engineer', 'Designer')).toEqual({
      kind: 'conflict',
      left: 'Backend Engineer',
      right: 'Designer'
    });
  });

  it('normalizes equivalent arrays and creates a stable enrichment union', () => {
    expect(
      compareClaimFieldValues(
        [' TypeScript ', 'PostgreSQL'],
        ['postgresql', 'TYPESCRIPT', 'TypeScript']
      )
    ).toEqual({
      kind: 'same',
      value: [' TypeScript ', 'PostgreSQL']
    });
    expect(
      compareClaimFieldValues(
        ['TypeScript', 'PostgreSQL'],
        ['postgresql', 'Docker']
      )
    ).toEqual({
      kind: 'enrichment',
      value: ['TypeScript', 'PostgreSQL', 'Docker'],
      from: 'both'
    });
  });

  it('treats scalar and array values as a conflict', () => {
    expect(compareClaimFieldValues('TypeScript', ['TypeScript'])).toEqual({
      kind: 'conflict',
      left: 'TypeScript',
      right: ['TypeScript']
    });
  });
});

describe('claim date field comparison', () => {
  it('classifies missing dates and one-sided enrichment', () => {
    expect(
      compareClaimDateFieldValues({ kind: 'missing' }, { kind: 'missing' })
    ).toEqual({ kind: 'same' });
    expect(
      compareClaimDateFieldValues(
        { kind: 'missing' },
        { kind: 'date', value: '2020' }
      )
    ).toEqual({
      kind: 'enrichment',
      value: { kind: 'date', value: '2020' },
      from: 'right'
    });
    expect(
      compareClaimDateFieldValues(
        { kind: 'present', asOf: '2024-06' },
        { kind: 'missing' }
      )
    ).toEqual({
      kind: 'enrichment',
      value: { kind: 'present', asOf: '2024-06' },
      from: 'left'
    });
  });

  it('selects the more precise compatible date in either direction', () => {
    expect(
      compareClaimDateFieldValues(
        { kind: 'date', value: '2020' },
        { kind: 'date', value: '2020-03' }
      )
    ).toEqual({
      kind: 'precision_improvement',
      value: { kind: 'date', value: '2020-03' },
      from: 'right'
    });
    expect(
      compareClaimDateFieldValues(
        { kind: 'date', value: '2020-03' },
        { kind: 'date', value: '2020' }
      )
    ).toEqual({
      kind: 'precision_improvement',
      value: { kind: 'date', value: '2020-03' },
      from: 'left'
    });
  });

  it('keeps compatible Present and explicit dates as an unresolved choice', () => {
    const left = { kind: 'present', asOf: '2024-06' } as const;
    const right = { kind: 'date', value: '2025' } as const;

    expect(compareClaimDateFieldValues(left, right)).toEqual({
      kind: 'compatible',
      left,
      right
    });
  });

  it('warns when Present has no source date and conflicts on bad dates', () => {
    const present = { kind: 'present' } as const;
    const explicit = { kind: 'date', value: '2024-06' } as const;
    expect(compareClaimDateFieldValues(present, explicit)).toEqual({
      kind: 'warning',
      left: present,
      right: explicit
    });

    const invalid = { kind: 'date', value: '2024-13' } as const;
    expect(compareClaimDateFieldValues(invalid, explicit)).toEqual({
      kind: 'conflict',
      left: invalid,
      right: explicit
    });
  });
});

describe('claim fields comparison', () => {
  it('compares employment fields including arrays and Present', () => {
    expect(
      compareClaimFields(
        claim(
          {
            employer: 'Example Labs',
            jobTitle: 'Backend Engineer',
            startDate: '2020',
            skills: ['TypeScript']
          },
          { current: true, currentAsOf: '2024-06' }
        ),
        claim({
          employer: ' example   labs ',
          jobTitle: 'Backend Engineer',
          startDate: '2020-03',
          endDate: '2025',
          location: 'Amman',
          skills: ['TypeScript', 'PostgreSQL']
        })
      )
    ).toEqual({
      result: 'compared',
      fields: {
        employer: { kind: 'same', value: 'Example Labs' },
        endDate: {
          kind: 'compatible',
          left: { kind: 'present', asOf: '2024-06' },
          right: { kind: 'date', value: '2025' }
        },
        jobTitle: { kind: 'same', value: 'Backend Engineer' },
        location: { kind: 'enrichment', value: 'Amman', from: 'right' },
        skills: {
          kind: 'enrichment',
          value: ['TypeScript', 'PostgreSQL'],
          from: 'both'
        },
        startDate: {
          kind: 'precision_improvement',
          value: { kind: 'date', value: '2020-03' },
          from: 'right'
        }
      }
    });
  });

  it('compares certification dates and optional fields', () => {
    expect(
      compareClaimFields(
        claim(
          { title: 'AWS Architect', issuer: 'Amazon', issueDate: '2024' },
          { claimType: 'certification' }
        ),
        claim(
          {
            title: 'AWS Architect',
            issuer: 'Amazon',
            issueDate: '2024-03',
            credentialId: 'ABC-123'
          },
          { claimType: 'certification' }
        )
      )
    ).toMatchObject({
      result: 'compared',
      fields: {
        issueDate: {
          kind: 'precision_improvement',
          value: { kind: 'date', value: '2024-03' },
          from: 'right'
        },
        credentialId: {
          kind: 'enrichment',
          value: 'ABC-123',
          from: 'right'
        }
      }
    });
  });

  it('refuses cross-candidate and cross-type field comparisons', () => {
    const skill = claim({ name: 'TypeScript' }, { claimType: 'skill' });

    expect(
      compareClaimFields(
        skill,
        claim(
          { name: 'TypeScript' },
          {
            candidateId: '22222222-2222-4222-8222-222222222222',
            claimType: 'skill'
          }
        )
      )
    ).toEqual({ result: 'not_comparable', reason: 'different_candidate' });
    expect(
      compareClaimFields(
        skill,
        claim({ name: 'TypeScript' }, { claimType: 'language' })
      )
    ).toEqual({ result: 'not_comparable', reason: 'different_type' });
  });
});

describe('claim survivor selection', () => {
  it('prefers manual or candidate-edited claims', () => {
    const extracted = mergeCandidate({
      status: 'accepted',
      claimId: '22222222-2222-4222-8222-222222222222'
    });

    expect(
      selectClaimSurvivor(
        mergeCandidate({ origin: 'manual', status: 'accepted' }),
        extracted
      )
    ).toEqual({
      result: 'selected',
      survivor: 'left',
      reason: 'candidate_authority'
    });
    expect(
      selectClaimSurvivor(
        extracted,
        mergeCandidate({
          claimId: '33333333-3333-4333-8333-333333333333',
          candidateEdited: true
        })
      )
    ).toEqual({
      result: 'selected',
      survivor: 'right',
      reason: 'candidate_authority'
    });
  });

  it('prefers accepted claims at equal authority', () => {
    expect(
      selectClaimSurvivor(
        mergeCandidate({ status: 'accepted' }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222'
        })
      )
    ).toEqual({
      result: 'selected',
      survivor: 'left',
      reason: 'accepted_status'
    });
  });

  it('requires a candidate choice between equally authoritative accepted claims', () => {
    expect(
      selectClaimSurvivor(
        mergeCandidate({ status: 'accepted' }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          status: 'accepted'
        })
      )
    ).toEqual({ result: 'candidate_choice_required' });
  });

  it('selects the oldest pending claim with a stable ID tie-breaker', () => {
    expect(
      selectClaimSurvivor(
        mergeCandidate({ createdAt: new Date('2026-02-01T00:00:00.000Z') }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          createdAt: new Date('2026-01-01T00:00:00.000Z')
        })
      )
    ).toEqual({
      result: 'selected',
      survivor: 'right',
      reason: 'oldest_pending'
    });
    expect(
      selectClaimSurvivor(
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222'
        }),
        mergeCandidate({
          claimId: '11111111-1111-4111-8111-111111111111'
        })
      )
    ).toEqual({
      result: 'selected',
      survivor: 'right',
      reason: 'claim_id_tiebreaker'
    });
  });

  it('refuses survivor selection across candidates or claim types', () => {
    const left = mergeCandidate();

    expect(
      selectClaimSurvivor(
        left,
        mergeCandidate({
          candidateId: '22222222-2222-4222-8222-222222222222'
        })
      )
    ).toEqual({ result: 'not_comparable', reason: 'different_candidate' });
    expect(
      selectClaimSurvivor(left, mergeCandidate({ claimType: 'language' }))
    ).toEqual({ result: 'not_comparable', reason: 'different_type' });
  });
});

describe('claim merge proposal', () => {
  it('builds an equivalent pending-claim proposal with version guards', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({ version: 3 }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          version: 5,
          values: { name: ' typescript ' },
          createdAt: new Date('2026-02-01T00:00:00.000Z')
        })
      )
    ).toMatchObject({
      result: 'proposal',
      identity: 'equivalent',
      left: {
        claimId: '11111111-1111-4111-8111-111111111111',
        version: 3
      },
      right: {
        claimId: '22222222-2222-4222-8222-222222222222',
        version: 5
      },
      survivorClaimId: '11111111-1111-4111-8111-111111111111',
      survivorReason: 'oldest_pending',
      proposedValues: { name: 'TypeScript' },
      unresolvedFields: [],
      requiresCandidateChoice: false,
      recommendedAction: 'automatic_coalesce'
    });
  });

  it('builds a suspected-duplicate proposal', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({ claimType: 'project', values: { name: 'LuminaCV' } }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'project',
          values: { name: ' luminacv ', description: 'Candidate profile app' }
        })
      )
    ).toMatchObject({
      result: 'proposal',
      identity: 'suspected_duplicate',
      recommendedAction: 'candidate_review',
      fields: {
        description: {
          kind: 'enrichment',
          value: 'Candidate profile app',
          from: 'right'
        }
      }
    });
  });

  it('lists conflicting fields as requiring candidate choice', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({
          claimType: 'language',
          values: { name: 'English', proficiency: 'professional' }
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'language',
          values: { name: 'English', proficiency: 'native' }
        })
      )
    ).toMatchObject({
      result: 'proposal',
      unresolvedFields: ['proficiency'],
      requiresCandidateChoice: true,
      proposedValues: { name: 'English' },
      fields: {
        proficiency: {
          kind: 'conflict',
          left: 'professional',
          right: 'native'
        }
      }
    });
  });

  it('proposes enrichment and date precision with authoritative formatting', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({
          claimType: 'certification',
          origin: 'manual',
          status: 'accepted',
          values: {
            title: ' AWS Architect ',
            issuer: 'Amazon',
            issueDate: '2024'
          }
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'certification',
          values: {
            title: 'aws architect',
            issuer: 'amazon',
            issueDate: '2024-03',
            credentialId: 'ABC-123'
          }
        })
      )
    ).toMatchObject({
      result: 'proposal',
      proposedValues: {
        title: ' AWS Architect ',
        issuer: 'Amazon',
        issueDate: '2024-03',
        credentialId: 'ABC-123'
      },
      unresolvedFields: []
    });
  });

  it('leaves the survivor unresolved for equally authoritative accepted claims', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({ status: 'accepted' }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          status: 'accepted'
        })
      )
    ).toMatchObject({
      result: 'proposal',
      survivorClaimId: null,
      survivorReason: null,
      requiresCandidateChoice: true,
      recommendedAction: 'candidate_review'
    });
  });

  it('requires review for an otherwise safe accepted or candidate-edited pair', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({ status: 'accepted' }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222'
        })
      )
    ).toMatchObject({
      result: 'proposal',
      recommendedAction: 'candidate_review'
    });
    expect(
      buildClaimMergeProposal(
        mergeCandidate({ candidateEdited: true }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222'
        })
      )
    ).toMatchObject({
      result: 'proposal',
      recommendedAction: 'candidate_review'
    });
  });

  it('preserves Present when both claims are current', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({
          claimType: 'employment',
          current: true,
          currentAsOf: '2025-06',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020'
          }
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'employment',
          current: true,
          currentAsOf: '2026-01',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020-03'
          }
        })
      )
    ).toMatchObject({
      result: 'proposal',
      proposedCurrent: true,
      recommendedAction: 'automatic_coalesce'
    });
  });

  it('leaves Present versus an explicit end date unresolved', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({
          claimType: 'employment',
          current: true,
          currentAsOf: '2024-06',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020'
          }
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'employment',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020-03',
            endDate: '2025'
          }
        })
      )
    ).toMatchObject({
      result: 'proposal',
      proposedCurrent: null,
      unresolvedFields: ['endDate'],
      recommendedAction: 'candidate_review'
    });
  });

  it('marks missing non-current end dates as not current', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate({
          claimType: 'employment',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020'
          }
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'employment',
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020-03'
          }
        })
      )
    ).toMatchObject({
      result: 'proposal',
      proposedCurrent: false
    });
  });

  it('does not propose merges for non-comparable or different identities', () => {
    expect(
      buildClaimMergeProposal(
        mergeCandidate(),
        mergeCandidate({
          candidateId: '22222222-2222-4222-8222-222222222222'
        })
      )
    ).toEqual({ result: 'no_proposal', reason: 'different_candidate' });
    expect(
      buildClaimMergeProposal(
        mergeCandidate(),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          values: { name: 'JavaScript' }
        })
      )
    ).toEqual({ result: 'no_proposal', reason: 'different_identity' });
  });
});

describe('automatic claim coalesce plan', () => {
  it('returns version-guarded final values for a safe automatic merge', () => {
    expect(
      buildAutomaticCoalescePlan(
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          version: 4,
          claimType: 'employment',
          current: true,
          currentAsOf: '2026-01',
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020'
          }
        }),
        mergeCandidate({
          claimId: '11111111-1111-4111-8111-111111111111',
          version: 7,
          claimType: 'employment',
          current: true,
          currentAsOf: '2026-02',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          values: {
            employer: 'Example Labs',
            jobTitle: 'Engineer',
            startDate: '2020-03',
            location: 'Amman'
          }
        })
      )
    ).toEqual({
      result: 'ready',
      survivor: {
        claimId: '11111111-1111-4111-8111-111111111111',
        expectedVersion: 7
      },
      duplicate: {
        claimId: '22222222-2222-4222-8222-222222222222',
        expectedVersion: 4
      },
      values: {
        employer: 'Example Labs',
        jobTitle: 'Engineer',
        location: 'Amman',
        startDate: '2020-03'
      },
      current: true,
      messages: ['Added location', 'More precise start date']
    });
  });

  it('refuses review-required, different, and identical claim pairs', () => {
    expect(
      buildAutomaticCoalescePlan(
        mergeCandidate({ status: 'accepted' }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222'
        })
      )
    ).toEqual({ result: 'candidate_review_required' });
    expect(
      buildAutomaticCoalescePlan(
        mergeCandidate(),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          values: { name: 'JavaScript' }
        })
      )
    ).toEqual({ result: 'no_merge', reason: 'different_identity' });
    expect(
      buildAutomaticCoalescePlan(mergeCandidate(), mergeCandidate())
    ).toEqual({ result: 'no_merge', reason: 'same_claim' });
  });
});

describe('automatic accepted-claim merge plan', () => {
  it('keeps an accepted survivor, publishes it for acknowledgment, and explains an exact merge', () => {
    expect(
      buildAutoAcceptMergePlan(
        mergeCandidate({
          status: 'accepted',
          origin: 'manual',
          createdAt: new Date('2026-01-01T00:00:00.000Z')
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          createdAt: new Date('2026-02-01T00:00:00.000Z')
        })
      )
    ).toMatchObject({
      result: 'ready',
      survivor: { claimId: '11111111-1111-4111-8111-111111111111' },
      duplicate: { claimId: '22222222-2222-4222-8222-222222222222' },
      status: 'auto_accepted',
      messages: ['Combined sources']
    });
  });

  it('does not merge a candidate-edited pending claim into an accepted claim', () => {
    expect(
      buildAutoAcceptMergePlan(
        mergeCandidate({ status: 'accepted', origin: 'manual' }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          candidateEdited: true
        })
      )
    ).toEqual({ result: 'candidate_review_required' });
  });
});

describe('confirmed claim merge plan', () => {
  it('builds an accepted version-guarded plan from candidate choices', () => {
    const left = mergeCandidate({
      version: 3,
      claimType: 'language',
      values: { name: 'English', proficiency: 'professional' }
    });
    const right = mergeCandidate({
      claimId: '22222222-2222-4222-8222-222222222222',
      version: 5,
      claimType: 'language',
      values: { name: 'English', proficiency: 'native' }
    });

    expect(
      buildConfirmedClaimMergePlan(left, right, {
        leftVersion: 3,
        rightVersion: 5,
        survivorClaimId: right.claimId,
        values: { name: 'English', proficiency: 'native' }
      })
    ).toEqual({
      result: 'ready',
      survivor: { claimId: right.claimId, expectedVersion: 5 },
      duplicate: { claimId: left.claimId, expectedVersion: 3 },
      values: { name: 'English', proficiency: 'native' },
      status: 'accepted'
    });
  });

  it('requires a choice for every unresolved field', () => {
    expect(
      buildConfirmedClaimMergePlan(
        mergeCandidate({
          claimType: 'language',
          values: { name: 'English', proficiency: 'professional' }
        }),
        mergeCandidate({
          claimId: '22222222-2222-4222-8222-222222222222',
          claimType: 'language',
          values: { name: 'English', proficiency: 'native' }
        }),
        {
          leftVersion: 1,
          rightVersion: 1,
          survivorClaimId: '11111111-1111-4111-8111-111111111111',
          values: { name: 'English' }
        }
      )
    ).toEqual({
      result: 'invalid_resolution',
      reason: 'missing_field_choice',
      fields: ['proficiency']
    });
  });

  it('requires an explicit Present or end-date choice', () => {
    const left = mergeCandidate({
      claimType: 'employment',
      current: true,
      currentAsOf: '2024-06',
      values: {
        employer: 'Example Labs',
        jobTitle: 'Engineer',
        startDate: '2020'
      }
    });
    const right = mergeCandidate({
      claimId: '22222222-2222-4222-8222-222222222222',
      claimType: 'employment',
      values: {
        employer: 'Example Labs',
        jobTitle: 'Engineer',
        startDate: '2020-03',
        endDate: '2025'
      }
    });
    const values = {
      employer: 'Example Labs',
      jobTitle: 'Engineer',
      startDate: '2020-03'
    };

    expect(
      buildConfirmedClaimMergePlan(left, right, {
        leftVersion: 1,
        rightVersion: 1,
        survivorClaimId: left.claimId,
        values
      })
    ).toEqual({
      result: 'invalid_resolution',
      reason: 'missing_field_choice',
      fields: ['endDate']
    });
    expect(
      buildConfirmedClaimMergePlan(left, right, {
        leftVersion: 1,
        rightVersion: 1,
        survivorClaimId: left.claimId,
        values,
        current: true
      })
    ).toMatchObject({ result: 'ready', current: true, status: 'accepted' });
    expect(
      buildConfirmedClaimMergePlan(left, right, {
        leftVersion: 1,
        rightVersion: 1,
        survivorClaimId: right.claimId,
        values: { ...values, endDate: '2025' },
        current: false
      })
    ).toMatchObject({ result: 'ready', current: false, status: 'accepted' });
  });

  it('rejects stale versions, unknown survivors, and Present with an end date', () => {
    const left = mergeCandidate({ version: 2 });
    const right = mergeCandidate({
      claimId: '22222222-2222-4222-8222-222222222222',
      version: 4
    });
    const baseInput = {
      leftVersion: 2,
      rightVersion: 4,
      survivorClaimId: left.claimId,
      values: { name: 'TypeScript' }
    };

    expect(
      buildConfirmedClaimMergePlan(left, right, {
        ...baseInput,
        leftVersion: 1
      })
    ).toEqual({
      result: 'version_conflict',
      left: { claimId: left.claimId, version: 2 },
      right: { claimId: right.claimId, version: 4 }
    });
    expect(
      buildConfirmedClaimMergePlan(left, right, {
        ...baseInput,
        survivorClaimId: '33333333-3333-4333-8333-333333333333'
      })
    ).toEqual({
      result: 'invalid_resolution',
      reason: 'invalid_survivor'
    });
    expect(
      buildConfirmedClaimMergePlan(left, right, {
        ...baseInput,
        values: { name: 'TypeScript', endDate: '2025' },
        current: true
      })
    ).toEqual({
      result: 'invalid_resolution',
      reason: 'inconsistent_current'
    });
  });
});
