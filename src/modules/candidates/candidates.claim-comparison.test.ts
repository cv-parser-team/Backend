import { describe, expect, it } from 'vitest';
import {
  compareClaimIdentity,
  compareClaimDateFieldValues,
  compareClaimDates,
  compareClaimFieldValues,
  compareClaimFields,
  compareClaims,
  type ComparableClaim
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
