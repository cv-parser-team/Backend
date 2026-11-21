import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { InvalidAiOutputError } from './extraction.errors.js';
import { collectAiInputReferences, mapAiOutput } from './extraction.mapper.js';
import { aiGenerationSchema } from './extraction.schemas.js';
import {
  validateClaim,
  validateEnvelope,
  validateProfile,
  validateUnmapped,
  validatorFor
} from './extraction.validator.js';

const employment = {
  type: 'employment',
  fields: {
    jobTitle: { value: 'Backend Developer', confidence: 0.95, sources: ['L10'] },
    employer: { value: 'Example Corp', confidence: 0.9, sources: ['L10'] },
    startDate: { value: '2023-10', raw: 'Oct 2023', confidence: 0.9, sources: ['L11'] },
    endDate: { current: true, raw: 'Present', confidence: 0.85, sources: ['L11'] },
    skills: { value: ['Node.js', 'PostgreSQL'], confidence: 0.8, sources: ['L12-13'] }
  }
};

describe('AI output contract', () => {
  it('uses a provider-compatible nested schema without weakening local mapping', () => {
    const validateGenerationOutput = validatorFor(aiGenerationSchema);
    const generatedOutput = {
      version: 1,
      profile: {},
      claims: [employment],
      unmapped: []
    };

    expect(validateGenerationOutput(generatedOutput).valid).toBe(true);
    expect(
      validateGenerationOutput({
        ...generatedOutput,
        claims: [{ type: 'employment', fields: { employer: employment.fields.employer } }]
      }).valid
    ).toBe(true);
    expect(
      validateGenerationOutput({
        ...generatedOutput,
        claims: [{ type: 'skill', notes: 'extra', fields: {} }]
      }).valid
    ).toBe(false);
    expect(validateEnvelope({ version: 1, claims: generatedOutput.claims }).valid).toBe(true);
  });

  it('accepts a version 1 output with claims', () => {
    expect(validateEnvelope({ version: 1, claims: [], unmapped: [] })).toEqual({
      valid: true,
      errors: [],
      fields: []
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
        fields: { name: { value: 'Python', confidence: 1, sources: [reference] } }
      };
      expect(validateClaim(claim).valid, reference).toBe(true);
    }
  });

  it('rejects fields without sources or confidence, or with bad values', () => {
    const name = (overrides: Record<string, unknown>) => ({
      ...employment,
      fields: { name: { value: 'Python', confidence: 0.9, sources: ['L1'], ...overrides } }
    });
    const invalidClaims = [
      name({ sources: [] }),
      name({ sources: ['line 5'] }),
      name({ confidence: 1.2 }),
      name({ confidence: undefined }),
      name({ page: 1 }),
      { ...employment, confidence: 0.9 }
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
        fullName: { value: 'Emma Carter', confidence: 0.99, sources: ['L1'] },
        links: [
          {
            value: 'https://github.com/emma',
            raw: 'GitHub',
            confidence: 0.9,
            sources: ['L4']
          }
        ]
      }).valid
    ).toBe(true);
    expect(
      validateProfile({ age: { value: '30', confidence: 0.9, sources: ['L2'] } }).valid
    ).toBe(false);
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

function field(value: string | string[], sources: string[], raw?: string, confidence = 0.9) {
  return raw === undefined ? { value, confidence, sources } : { value, raw, confidence, sources };
}

function output(claims: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 1, claims, ...extra };
}

describe('AI output mapping', () => {
  it('collects exact PDF and DOCX references while ignoring headers and table columns', () => {
    expect(
      [...collectAiInputReferences([
        '[P1 R0 header]',
        '## L5 Profile',
        'L6-8,10 Experience spanning lines',
        '## B3 Skills',
        'Columns: Skill | Level',
        'B4.1 TypeScript | Advanced'
      ].join('\n'))]
    ).toEqual(['L5', 'L6-8,10', 'B3', 'B4.1']);
  });

  it('turns a valid claim into a pending extracted draft with its sources', () => {
    const result = mapAiOutput(output([employment]));

    expect(result.unmapped).toEqual([]);
    expect(result.claims).toEqual([
      {
        type: 'employment',
        origin: 'extracted',
        status: 'pending',
        confidence: 0.8,
        fieldConfidence: {
          jobTitle: 0.95,
          employer: 0.9,
          startDate: 0.9,
          endDate: 0.85,
          skills: 0.8
        },
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
    ];

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

  it('separates an explicitly combined degree and field of study', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'education',
          fields: {
            institution: field('Borcelle University', ['L20']),
            degree: field('Bachelor of Arts in Accounting', ['L21']),
            startDate: field('2023', ['L22']),
            endDate: field('2026', ['L22'])
          }
        }
      ])
    );

    expect(result.reviewItems).toEqual([]);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      type: 'education',
      values: {
        institution: 'Borcelle University',
        degree: 'Bachelor of Arts',
        fieldOfStudy: 'Accounting',
        startDate: '2023',
        endDate: '2026'
      },
      rawValues: {
        degree: 'Bachelor of Arts',
        fieldOfStudy: 'Accounting'
      },
      fieldSources: {
        degree: ['L21'],
        fieldOfStudy: ['L21']
      }
    });
  });

  it('turns comma-separated or array skill values into individual claims', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'skill',
          fields: { name: field('React, TypeScript, Node.js', ['L30'], undefined, 0.96) }
        },
        {
          type: 'skill',
          fields: { name: field(['SQL', 'PostgreSQL'], ['L31'], undefined, 0.97) }
        }
      ])
    );

    expect(result.reviewItems).toEqual([]);
    expect(result.claims.map((claim) => claim.values.name)).toEqual([
      'React',
      'TypeScript',
      'Node.js',
      'SQL',
      'PostgreSQL'
    ]);
    expect(result.claims.every((claim) => claim.status === 'accepted')).toBe(true);
  });

  it('keeps a doubtful value and gives the claim its lowest field confidence', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'language',
          fields: {
            name: field('Spanish', ['L34'], undefined, 0.95),
            proficiency: field('B2', ['L34'], undefined, 0.4)
          }
        }
      ])
    );

    expect(result.unmapped).toEqual([]);
    expect(result.claims[0]).toMatchObject({
      status: 'pending',
      values: { name: 'Spanish', proficiency: 'B2' },
      fieldConfidence: { name: 0.95, proficiency: 0.4 },
      confidence: 0.4
    });
  });

  it('accepts a fully sourced claim when every field has high confidence', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'skill',
          fields: { name: field('TypeScript', ['L1'], undefined, 0.95) }
        }
      ]),
      new Set(['L1'])
    );

    expect(result.claims[0]).toMatchObject({
      status: 'accepted',
      confidence: 0.95
    });
    expect(result.reviewItems).toEqual([]);
  });

  it('keeps year-only and mixed-precision dates without inventing months', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'employment',
          fields: {
            employer: field('Example Corp', ['L1']),
            jobTitle: field('Developer', ['L1']),
            startDate: field('2021', ['L2'], '2021-2024'),
            endDate: field('2024', ['L2'], '2021-2024')
          }
        },
        {
          type: 'certification',
          fields: {
            title: field('Writing for Marketing', ['L3']),
            issuer: field('Example Institute', ['L4']),
            issueDate: field('2023', ['L3'], '2023')
          }
        }
      ])
    );

    expect(result.unmapped).toEqual([]);
    expect(result.claims[0]).toMatchObject({
      values: { startDate: '2021', endDate: '2024' },
      rawValues: { startDate: '2021-2024', endDate: '2021-2024' }
    });
    expect(result.claims[1]).toMatchObject({
      type: 'certification',
      values: { issueDate: '2023' }
    });
  });

  it.each([
    [
      'a required field is missing',
      'employment',
      { jobTitle: field('Developer', ['L1']), startDate: field('2021-03', ['L2']) },
      'missing_employer'
    ],
    [
      'the required start date is malformed',
      'education',
      {
        institution: field('Sample University', ['L1']),
        degree: field('BSc', ['L1']),
        startDate: field('2021-00', ['L2'])
      },
      'invalid_date'
    ],
    [
      'a required value is too long',
      'language',
      { name: field('x'.repeat(101), ['L1']) },
      'invalid_value'
    ]
  ])('keeps the whole claim for review when %s', (_case, type, fields, reason) => {
    const result = mapAiOutput(output([{ type, fields }]));

    expect(result.claims).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.reviewItems).toEqual([
      expect.objectContaining({
        claimType: type,
        fields,
        issues: [expect.objectContaining({ code: reason, required: true })]
      })
    ]);
    expect(result.reviewItems[0]!.sources.length).toBeGreaterThan(0);
    expect(result.reviewItems[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [
      'the end date is malformed',
      'education',
      {
        institution: field('Sample University', ['L1']),
        degree: field('BSc', ['L1']),
        startDate: field('2019-09', ['L2']),
        endDate: field('2023-13', ['L2'])
      },
      'endDate',
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
      'endDate',
      'invalid_date_order'
    ],
    [
      'a field does not belong to the type',
      'skill',
      { name: field('Python', ['L1']), level: field('Expert', ['L1']) },
      'level',
      'invalid_value'
    ],
    [
      'an optional value is too long',
      'employment',
      {
        jobTitle: field('Developer', ['L1']),
        employer: field('Example Corp', ['L1']),
        startDate: field('2021-03', ['L2']),
        location: field('x'.repeat(201), ['L3'])
      },
      'location',
      'invalid_value'
    ],
    [
      'an optional field has text but no value',
      'project',
      {
        name: field('Shop API', ['L1']),
        startDate: { raw: 'Spring 2024', confidence: 0.5, sources: ['L2'] }
      },
      'startDate',
      'missing_value'
    ]
  ])('keeps a valid remainder and sends the invalid field to review when %s', (_case, type, fields, fieldName, reason) => {
    const result = mapAiOutput(output([{ type, fields }]));

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.status).toBe('pending');
    expect(result.claims[0]!.values).not.toHaveProperty(fieldName);
    expect(result.claims[0]!.fieldConfidence).not.toHaveProperty(fieldName);
    expect(result.unmapped).toEqual([]);
    expect(result.reviewItems).toEqual([
      expect.objectContaining({
        claimType: type,
        fields,
        issues: [{ field: fieldName, code: reason, required: false }]
      })
    ]);
  });

  it('leaves set-aside fields out of confidence but keeps the claim pending', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'project',
          fields: {
            name: field('Shop API', ['L1'], undefined, 0.99),
            endDate: field('2024-13', ['L2'], undefined, 0.2)
          }
        }
      ])
    );

    expect(result.claims[0]).toMatchObject({ confidence: 0.99, status: 'pending' });
  });

  it('rejects a claim when a required field cites an unknown source', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'employment',
          fields: {
            jobTitle: field('Developer', ['L1']),
            employer: field('Example Corp', ['L99']),
            startDate: field('2021-03', ['L2'])
          }
        }
      ]),
      new Set(['L1', 'L2'])
    );

    expect(result.claims).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.reviewItems).toEqual([
      expect.objectContaining({
        claimType: 'employment',
        issues: [{ field: 'employer', code: 'invalid_source', required: true }],
        sources: ['L1', 'L99', 'L2']
      })
    ]);
  });

  it('sets aside only optional and profile fields with unknown sources', () => {
    const result = mapAiOutput(
      output(
        [
          {
            type: 'project',
            fields: {
              name: field('Shop API', ['B3']),
              description: field('Built payment APIs', ['B99'])
            }
          }
        ],
        {
          profile: {
            fullName: field('Emma Carter', ['L5-7']),
            headline: field('Backend Developer', ['L8']),
            summary: { raw: 'API specialist', confidence: 0.7, sources: ['L100'] }
          },
          unmapped: [
            { label: 'Award', text: 'Best Graduate', sources: ['L50'] },
            { label: 'Course', text: 'Advanced TypeScript', sources: ['B4.1'] }
          ]
        }
      ),
      new Set(['L5-7', 'B3', 'B4.1'])
    );

    expect(result.profile.values).toEqual({ fullName: 'Emma Carter' });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.values).toEqual({ name: 'Shop API' });
    expect(result.reviewItems).toEqual([
      expect.objectContaining({
        claimType: 'project',
        issues: [{ field: 'description', code: 'invalid_source', required: false }],
        sources: ['B3', 'B99']
      })
    ]);
    expect(result.unmapped).toEqual([
      {
        label: 'profile.headline',
        text: 'Backend Developer',
        sources: ['L8'],
        reason: 'invalid_source'
      },
      {
        label: 'profile.summary',
        text: 'API specialist',
        sources: ['L100'],
        reason: 'invalid_source'
      },
      {
        label: 'Award',
        text: 'Best Graduate',
        sources: ['L50'],
        reason: 'invalid_source'
      },
      {
        label: 'Course',
        text: 'Advanced TypeScript',
        sources: ['B4.1'],
        reason: 'unsupported_section'
      }
    ]);
  });

  it('keeps valid claims when other items in the same output are invalid', () => {
    const result = mapAiOutput(
      output([
        { type: 'award', fields: { name: field('Best Graduate', ['L30']) } },
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

  it('retains a structurally invalid recognized claim for review', () => {
    const malformed = {
      type: 'skill',
      fields: {
        name: { value: 'TypeScript', confidence: 0.9, sources: [] }
      }
    };

    const result = mapAiOutput(output([malformed]));

    expect(result.claims).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.reviewItems).toEqual([
      expect.objectContaining({
        claimType: 'skill',
        fields: malformed.fields,
        issues: [{ field: null, code: 'invalid_item', required: false }],
        sources: []
      })
    ]);
  });

  it('keeps the text as written when a claim needs review', () => {
    const result = mapAiOutput(
      output([
        {
          type: 'education',
          fields: {
            institution: field('Sample University', ['L1']),
            degree: field('BSc', ['L1']),
            startDate: field('2021-00', ['L2'], 'Class of 2021')
          }
        }
      ])
    );

    expect(result.unmapped).toEqual([]);
    expect(result.reviewItems[0]).toMatchObject({
      claimType: 'education',
      fields: { startDate: { raw: 'Class of 2021' } },
      sources: ['L1', 'L2'],
      issues: [{ field: 'startDate', code: 'invalid_date', required: true }]
    });
  });

  it('maps the profile and keeps invalid profile fields as unmapped', () => {
    const result = mapAiOutput(
      output([], {
        profile: {
          fullName: field(' Emma Carter ', ['L1'], undefined, 0.99),
          contactEmail: field('emma at example', ['L3']),
          links: [
            field('https://github.com/emma', ['L4'], 'GitHub', 0.8),
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
      confidence: { fullName: 0.99, profileLinks: 0.8 },
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
      education: 2,
      certification: 1,
      skill: 3,
      language: 2,
      project: 2
    });
    expect(
      result.claims.every(
        (claim) =>
          claim.origin === 'extracted' &&
          (claim.status === 'accepted' || claim.status === 'pending') &&
          claim.sources.length > 0 &&
          (claim.status !== 'accepted' || claim.confidence >= 0.95)
      )
    ).toBe(true);
    expect(result.claims.some((claim) => claim.status === 'accepted')).toBe(true);
    expect(result.claims[0]).toMatchObject({ current: true, confidence: 0.75 });
    expect(result.reviewItems).toEqual([
      expect.objectContaining({
        claimType: 'project',
        issues: [{ field: 'endDate', code: 'invalid_date_order', required: false }]
      })
    ]);
    expect(result.unmapped.map(({ label, reason }) => [label, reason])).toEqual([
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
