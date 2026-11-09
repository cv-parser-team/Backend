import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { InvalidAiOutputError } from './extraction.errors.js';
import { mapAiOutput } from './extraction.mapper.js';
import {
  validateClaim,
  validateEnvelope,
  validateProfile,
  validateUnmapped,
  validatorFor
} from './extraction.validator.js';

const employment = {
  type: 'employment',
  confidence: 0.9,
  fields: {
    jobTitle: { value: 'Backend Developer', sources: ['L10'] },
    employer: { value: 'Example Corp', sources: ['L10'] },
    startDate: { value: '2023-10', raw: 'Oct 2023', sources: ['L11'] },
    endDate: { current: true, raw: 'Present', sources: ['L11'] },
    skills: { value: ['Node.js', 'PostgreSQL'], sources: ['L12-13'] }
  }
};

describe('AI output contract', () => {
  it('accepts a version 1 output with claims', () => {
    expect(validateEnvelope({ version: 1, claims: [], unmapped: [] })).toEqual({
      valid: true,
      errors: []
    });
  });

  it('rejects another version, a missing claims list, or unknown top-level fields', () => {
    for (const output of [
      { version: 2, claims: [] },
      { version: 1 },
      { version: 1, claims: [], notes: 'extra' },
      'not an object'
    ]) {
      expect(validateEnvelope(output).valid).toBe(false);
    }
  });

  it('accepts a claim whose every field has line references', () => {
    expect(validateClaim(employment).valid).toBe(true);
  });

  it('accepts PDF and DOCX line references', () => {
    for (const reference of ['L5', 'L5-7', 'L39-41,44', 'B3', 'B4.1']) {
      const claim = {
        type: 'skill',
        confidence: 1,
        fields: { name: { value: 'Python', sources: [reference] } }
      };
      expect(validateClaim(claim).valid, reference).toBe(true);
    }
  });

  it('rejects a field without sources, a bad reference, or a confidence above 1', () => {
    const invalidClaims = [
      { ...employment, fields: { name: { value: 'Python', sources: [] } } },
      { ...employment, fields: { name: { value: 'Python', sources: ['line 5'] } } },
      { ...employment, confidence: 1.2 },
      { ...employment, fields: { name: { value: 'Python', page: 1, sources: ['L1'] } } }
    ];

    for (const claim of invalidClaims) {
      expect(validateClaim(claim).valid).toBe(false);
    }
  });

  it('rejects an unknown claim type', () => {
    const result = validateClaim({ ...employment, type: 'award' });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('/type');
  });

  it('checks the profile and unmapped items on their own', () => {
    expect(
      validateProfile({
        fullName: { value: 'Emma Carter', sources: ['L1'] },
        links: [{ value: 'https://github.com/emma', raw: 'GitHub', sources: ['L4'] }]
      }).valid
    ).toBe(true);
    expect(validateProfile({ age: { value: '30', sources: ['L2'] } }).valid).toBe(false);
    expect(
      validateUnmapped({ label: 'Courses', text: 'Advanced Laravel', sources: ['L45'] }).valid
    ).toBe(true);
    expect(validateUnmapped({ label: 'Courses', sources: ['L45'] }).valid).toBe(false);
  });

  it('supports formats such as email in shared value schemas', () => {
    const validateEmail = validatorFor({ type: 'string', format: 'email' });

    expect(validateEmail('emma@example.com').valid).toBe(true);
    expect(validateEmail('not an email').valid).toBe(false);
  });
});

function field(value: string | string[], sources: string[], raw?: string) {
  return raw === undefined ? { value, sources } : { value, raw, sources };
}

function output(claims: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 1, claims, ...extra };
}

describe('AI output mapping', () => {
  it('turns a valid claim into a pending extracted draft with its sources', () => {
    const result = mapAiOutput(output([employment]));

    expect(result.unmapped).toEqual([]);
    expect(result.claims).toEqual([
      {
        type: 'employment',
        origin: 'extracted',
        status: 'pending',
        confidence: 0.9,
        current: true,
        values: {
          jobTitle: 'Backend Developer',
          employer: 'Example Corp',
          startDate: '2023-10',
          skills: ['Node.js', 'PostgreSQL']
        },
        rawValues: { startDate: 'Oct 2023', endDate: 'Present' },
        sources: ['L10', 'L11', 'L12-13'],
        fieldSources: {
          jobTitle: ['L10'],
          employer: ['L10'],
          startDate: ['L11'],
          endDate: ['L11'],
          skills: ['L12-13']
        }
      }
    ]);
  });

  it('maps every claim type', () => {
    const claims = [
      { type: 'skill', fields: { name: field('Python', ['L20']) } },
      {
        type: 'education',
        fields: {
          institution: field('Sample University', ['L21']),
          degree: field('BSc', ['L21']),
          startDate: field('2019-09', ['L22']),
          endDate: field('2023-06', ['L22'])
        }
      },
      {
        type: 'certification',
        fields: {
          title: field('AWS Developer', ['L23']),
          issuer: field('Amazon', ['L23']),
          issueDate: field('2024-01', ['L23'])
        }
      },
      {
        type: 'language',
        fields: { name: field('English', ['L24']), proficiency: field('Native', ['L24']) }
      },
      {
        type: 'project',
        fields: {
          name: field('Shop API', ['L25']),
          url: field('https://github.com/emma/shop', ['L25'])
        }
      }
    ].map((claim) => ({ ...claim, confidence: 0.8 }));

    const result = mapAiOutput(output(claims));

    expect(result.unmapped).toEqual([]);
    expect(result.claims.map((claim) => claim.type)).toEqual([
      'skill',
      'education',
      'certification',
      'language',
      'project'
    ]);
  });

  it.each([
    [
      'a required field is missing',
      'employment',
      { name: field('Shop API', ['L1']) },
      'missing_employer'
    ],
    [
      'the start date has only a year',
      'education',
      {
        institution: field('Sample University', ['L1']),
        degree: field('BSc', ['L1']),
        startDate: field('2021', ['L2'])
      },
      'invalid_date'
    ],
    [
      'the end date is before the start date',
      'project',
      {
        name: field('Shop API', ['L1']),
        startDate: field('2024-06', ['L2']),
        endDate: field('2024-03', ['L2'])
      },
      'invalid_date_order'
    ],
    [
      'a field does not belong to the type',
      'skill',
      { name: field('Python', ['L1']), level: field('Expert', ['L1']) },
      'invalid_value'
    ],
    ['a value is too long', 'language', { name: field('x'.repeat(101), ['L1']) }, 'invalid_value']
  ])('keeps the claim as unmapped when %s', (_case, type, fields, reason) => {
    const result = mapAiOutput(output([{ type, confidence: 0.7, fields }]));

    expect(result.claims).toEqual([]);
    expect(result.unmapped).toEqual([expect.objectContaining({ label: type, reason })]);
    expect(result.unmapped[0]!.sources.length).toBeGreaterThan(0);
  });

  it('keeps valid claims when other items in the same output are invalid', () => {
    const result = mapAiOutput(
      output([
        { type: 'award', confidence: 0.9, fields: { name: field('Best Graduate', ['L30']) } },
        employment,
        'not a claim'
      ])
    );

    expect(result.claims).toHaveLength(1);
    expect(result.unmapped).toEqual([
      { label: 'award', text: 'Best Graduate', sources: ['L30'], reason: 'invalid_item' },
      { label: 'unknown', text: 'not a claim', sources: [], reason: 'invalid_item' }
    ]);
  });

  it('keeps the text as written when an item is unmapped', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'education',
          confidence: 0.6,
          fields: {
            institution: field('Sample University', ['L1']),
            degree: field('BSc', ['L1']),
            startDate: field('2021', ['L2'], 'Class of 2021')
          }
        }
      ])
    );

    expect(result.unmapped[0]).toEqual({
      label: 'education',
      text: 'Sample University; BSc; Class of 2021',
      sources: ['L1', 'L2'],
      reason: 'invalid_date'
    });
  });

  it('maps the profile and keeps invalid profile fields as unmapped', () => {
    const result = mapAiOutput(
      output([], {
        profile: {
          fullName: field(' Emma Carter ', ['L1']),
          contactEmail: field('emma at example', ['L3']),
          links: [
            field('https://github.com/emma', ['L4'], 'GitHub'),
            field('https://linkedin.com/in/emma', ['L4'])
          ]
        }
      })
    );

    expect(result.profile).toEqual({
      values: {
        fullName: 'Emma Carter',
        profileLinks: [{ label: 'GitHub', url: 'https://github.com/emma' }]
      },
      rawValues: {},
      sources: { fullName: ['L1'], profileLinks: ['L4'] }
    });
    expect(result.unmapped).toEqual([
      {
        label: 'profile.contactEmail',
        text: 'emma at example',
        sources: ['L3'],
        reason: 'invalid_value'
      },
      {
        label: 'profile.links',
        text: 'https://linkedin.com/in/emma',
        sources: ['L4'],
        reason: 'missing_label'
      }
    ]);
  });

  it('keeps the text of a profile that does not follow the contract', () => {
    const result = mapAiOutput(
      output([], {
        profile: {
          fullName: field('Emma Carter', ['L1']),
          age: field('30', ['L2']),
          links: [field('https://github.com/emma', ['L4'], 'GitHub')]
        }
      })
    );

    expect(result.profile.values).toEqual({});
    expect(result.unmapped).toEqual([
      {
        label: 'profile',
        text: 'Emma Carter; 30; GitHub',
        sources: ['L1', 'L2', 'L4'],
        reason: 'invalid_item'
      }
    ]);
  });

  it('keeps information the AI could not place as unmapped', () => {
    const result = mapAiOutput(
      output([], {
        unmapped: [{ label: 'Courses', text: 'Advanced Laravel (09/2022)', sources: ['L45'] }]
      })
    );

    expect(result.unmapped).toEqual([
      {
        label: 'Courses',
        text: 'Advanced Laravel (09/2022)',
        sources: ['L45'],
        reason: 'unsupported_section'
      }
    ]);
  });

  it('maps a representative CV output without losing any text', async () => {
    const fixture: unknown = JSON.parse(
      await readFile(new URL('./__fixtures__/emma.ai-output.json', import.meta.url), 'utf8')
    );

    const result = mapAiOutput(fixture);
    const countByType = result.claims.reduce<Record<string, number>>((counts, claim) => {
      counts[claim.type] = (counts[claim.type] ?? 0) + 1;
      return counts;
    }, {});

    expect(countByType).toEqual({
      employment: 2,
      education: 1,
      certification: 1,
      skill: 3,
      language: 2,
      project: 1
    });
    expect(
      result.claims.every(
        (claim) =>
          claim.origin === 'extracted' && claim.status === 'pending' && claim.sources.length > 0
      )
    ).toBe(true);
    expect(result.claims[0]).toMatchObject({ current: true, confidence: 0.95 });
    expect(result.unmapped.map(({ label, reason }) => [label, reason])).toEqual([
      ['education', 'invalid_date'],
      ['project', 'invalid_date_order'],
      ['award', 'invalid_item'],
      ['Courses', 'unsupported_section'],
      ['Interests', 'unsupported_section']
    ]);
    expect(result.profile.values).toMatchObject({
      fullName: 'Emma Carter',
      contactEmail: 'emma.carter@example.com',
      profileLinks: [
        { label: 'LinkedIn', url: 'https://www.linkedin.com/in/emma-carter' },
        { label: 'GitHub', url: 'https://github.com/emma-carter' }
      ]
    });

    // Every field keeps its text as the CV wrote it, or its value when no raw
    // text was given, in a draft, the profile, or unmapped.
    const mapped = JSON.stringify(result);
    const keptTexts: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collect);
      } else if (typeof node === 'object' && node !== null) {
        const record = node as Record<string, unknown>;
        if (Array.isArray(record.sources)) {
          const kept = record.raw ?? record.text ?? record.value;
          keptTexts.push(...(Array.isArray(kept) ? kept : [kept]).map(String));
        }
        Object.values(record).forEach(collect);
      }
    };
    collect(fixture);

    expect(keptTexts.length).toBeGreaterThan(40);
    for (const text of keptTexts) {
      expect(mapped, text).toContain(text);
    }
  });

  it('rejects an output that does not follow the contract as a whole', () => {
    expect(() => mapAiOutput({ version: 2, claims: [] })).toThrow(InvalidAiOutputError);
    expect(() => mapAiOutput({ version: 1 })).toThrow(InvalidAiOutputError);
    expect(() => mapAiOutput(null)).toThrow(InvalidAiOutputError);
  });
});
