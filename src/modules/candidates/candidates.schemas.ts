import { FromSchema } from 'json-schema-to-ts';

const shortTextSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '\\S'
} as const;

const longTextSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 5000,
  pattern: '\\S'
} as const;

const phoneSchema = { type: 'string', minLength: 1, maxLength: 30 } as const;

// Year and month only (YYYY-MM), matching how CVs usually present dates.
const monthSchema = {
  type: 'string',
  pattern: '^\\d{4}-(0[1-9]|1[0-2])$'
} as const;

const profileLinkSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 50, pattern: '\\S' },
    url: { type: 'string', format: 'uri', maxLength: 2048 }
  },
  required: ['label', 'url'],
  additionalProperties: false
} as const;

const profileLinksSchema = {
  type: 'array',
  maxItems: 20,
  items: profileLinkSchema
} as const;

export const createCandidateBodySchema = {
  type: 'object',
  properties: {
    fullName: shortTextSchema,
    headline: shortTextSchema,
    summary: longTextSchema,
    phone: phoneSchema,
    location: shortTextSchema,
    profileLinks: profileLinksSchema
  },
  required: ['fullName'],
  additionalProperties: false
} as const;

export type CreateCandidateBody = FromSchema<typeof createCandidateBodySchema>;

export const updateCandidateBodySchema = {
  type: 'object',
  properties: {
    fullName: shortTextSchema,
    headline: { anyOf: [shortTextSchema, { type: 'null' }] },
    summary: { anyOf: [longTextSchema, { type: 'null' }] },
    phone: { anyOf: [phoneSchema, { type: 'null' }] },
    location: { anyOf: [shortTextSchema, { type: 'null' }] },
    profileLinks: profileLinksSchema
  },
  minProperties: 1,
  additionalProperties: false
} as const;

export type UpdateCandidateBody = FromSchema<typeof updateCandidateBodySchema>;

export const skillValuesSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
  },
  required: ['name'],
  additionalProperties: false
} as const;

export const employmentValuesSchema = {
  type: 'object',
  properties: {
    employer: shortTextSchema,
    jobTitle: shortTextSchema,
    startDate: monthSchema,
    endDate: monthSchema,
    description: longTextSchema,
    location: shortTextSchema,
    skills: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
    }
  },
  required: ['employer', 'jobTitle', 'startDate'],
  additionalProperties: false
} as const;

export const educationValuesSchema = {
  type: 'object',
  properties: {
    institution: shortTextSchema,
    degree: shortTextSchema,
    fieldOfStudy: shortTextSchema,
    startDate: monthSchema,
    endDate: monthSchema
  },
  required: ['institution', 'degree', 'startDate'],
  additionalProperties: false
} as const;

export const certificationValuesSchema = {
  type: 'object',
  properties: {
    title: shortTextSchema,
    issuer: shortTextSchema,
    issueDate: monthSchema,
    expiryDate: monthSchema,
    credentialId: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
  },
  required: ['title', 'issuer', 'issueDate'],
  additionalProperties: false
} as const;

export type SkillValues = FromSchema<typeof skillValuesSchema>;
export type EmploymentValues = FromSchema<typeof employmentValuesSchema>;
export type EducationValues = FromSchema<typeof educationValuesSchema>;
export type CertificationValues = FromSchema<typeof certificationValuesSchema>;

const claimTypeSchema = {
  type: 'string',
  enum: ['skill', 'employment', 'education', 'certification']
} as const;

const claimStatusSchema = {
  type: 'string',
  enum: ['pending', 'accepted', 'rejected']
} as const;

// Fastify's default Ajv options remove additional properties, which breaks
// oneOf branches that use additionalProperties: false. if/then only applies
// the values schema that matches the claim type.
export const claimBodySchema = {
  type: 'object',
  properties: {
    type: claimTypeSchema,
    values: { type: 'object' }
  },
  required: ['type', 'values'],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { type: { const: 'skill' } } },
      then: { properties: { values: skillValuesSchema } }
    },
    {
      if: { properties: { type: { const: 'employment' } } },
      then: { properties: { values: employmentValuesSchema } }
    },
    {
      if: { properties: { type: { const: 'education' } } },
      then: { properties: { values: educationValuesSchema } }
    },
    {
      if: { properties: { type: { const: 'certification' } } },
      then: { properties: { values: certificationValuesSchema } }
    }
  ]
} as const;

export type ClaimBody =
  | { type: 'skill'; values: SkillValues }
  | { type: 'employment'; values: EmploymentValues }
  | { type: 'education'; values: EducationValues }
  | { type: 'certification'; values: CertificationValues };

export const claimParamsSchema = {
  type: 'object',
  properties: {
    claimId: { type: 'string', format: 'uuid' }
  },
  required: ['claimId'],
  additionalProperties: false
} as const;

export type ClaimParams = FromSchema<typeof claimParamsSchema>;

export const listClaimsQuerySchema = {
  type: 'object',
  properties: {
    type: claimTypeSchema,
    status: claimStatusSchema
  },
  additionalProperties: false
} as const;

export type ListClaimsQuery = FromSchema<typeof listClaimsQuerySchema>;
