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

const contactEmailSchema = { type: 'string', format: 'email', maxLength: 320 } as const;

// Preserve the precision supplied by the candidate or CV. A year is valid on
// its own; a month is never invented to make a partial date pass validation.
const claimDateSchema = {
  type: 'string',
  pattern: '^\\d{4}(-(0[1-9]|1[0-2]))?$'
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
    contactEmail: contactEmailSchema,
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
    contactEmail: { anyOf: [contactEmailSchema, { type: 'null' }] },
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
    startDate: claimDateSchema,
    endDate: claimDateSchema,
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
    startDate: claimDateSchema,
    endDate: claimDateSchema
  },
  required: ['institution', 'degree', 'startDate'],
  additionalProperties: false
} as const;

export const certificationValuesSchema = {
  type: 'object',
  properties: {
    title: shortTextSchema,
    issuer: shortTextSchema,
    issueDate: claimDateSchema,
    expiryDate: claimDateSchema,
    credentialId: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
  },
  required: ['title', 'issuer', 'issueDate'],
  additionalProperties: false
} as const;

export const languageValuesSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
    proficiency: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
  },
  required: ['name'],
  additionalProperties: false
} as const;

export const projectValuesSchema = {
  type: 'object',
  properties: {
    name: shortTextSchema,
    description: longTextSchema,
    role: shortTextSchema,
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    startDate: claimDateSchema,
    endDate: claimDateSchema,
    skills: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }
    }
  },
  required: ['name'],
  additionalProperties: false
} as const;

export type SkillValues = FromSchema<typeof skillValuesSchema>;
export type EmploymentValues = FromSchema<typeof employmentValuesSchema>;
export type EducationValues = FromSchema<typeof educationValuesSchema>;
export type CertificationValues = FromSchema<typeof certificationValuesSchema>;
export type LanguageValues = FromSchema<typeof languageValuesSchema>;
export type ProjectValues = FromSchema<typeof projectValuesSchema>;

const claimTypeSchema = {
  type: 'string',
  enum: ['skill', 'employment', 'education', 'certification', 'language', 'project']
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
    },
    {
      if: { properties: { type: { const: 'language' } } },
      then: { properties: { values: languageValuesSchema } }
    },
    {
      if: { properties: { type: { const: 'project' } } },
      then: { properties: { values: projectValuesSchema } }
    }
  ]
} as const;

export type ClaimBody =
  | { type: 'skill'; values: SkillValues }
  | { type: 'employment'; values: EmploymentValues }
  | { type: 'education'; values: EducationValues }
  | { type: 'certification'; values: CertificationValues }
  | { type: 'language'; values: LanguageValues }
  | { type: 'project'; values: ProjectValues };

export const claimParamsSchema = {
  type: 'object',
  properties: {
    claimId: { type: 'string', format: 'uuid' }
  },
  required: ['claimId'],
  additionalProperties: false
} as const;

export type ClaimParams = FromSchema<typeof claimParamsSchema>;

export const claimMergeProposalQuerySchema = {
  type: 'object',
  properties: {
    leftClaimId: { type: 'string', format: 'uuid' },
    rightClaimId: { type: 'string', format: 'uuid' }
  },
  required: ['leftClaimId', 'rightClaimId'],
  additionalProperties: false
} as const;

export type ClaimMergeProposalQuery = FromSchema<
  typeof claimMergeProposalQuerySchema
>;

export const claimCoalesceBodySchema = claimMergeProposalQuerySchema;
export type ClaimCoalesceBody = ClaimMergeProposalQuery;

export const recordClaimsDifferentBodySchema = {
  type: 'object',
  properties: {
    leftClaimId: { type: 'string', format: 'uuid' },
    rightClaimId: { type: 'string', format: 'uuid' },
    leftVersion: { type: 'integer', minimum: 1 },
    rightVersion: { type: 'integer', minimum: 1 }
  },
  required: ['leftClaimId', 'rightClaimId', 'leftVersion', 'rightVersion'],
  additionalProperties: false
} as const;

export type RecordClaimsDifferentBody = FromSchema<
  typeof recordClaimsDifferentBodySchema
>;

export const confirmClaimMergeBodySchema = {
  type: 'object',
  properties: {
    leftClaimId: { type: 'string', format: 'uuid' },
    rightClaimId: { type: 'string', format: 'uuid' },
    leftVersion: { type: 'integer', minimum: 1 },
    rightVersion: { type: 'integer', minimum: 1 },
    survivorClaimId: { type: 'string', format: 'uuid' },
    values: { type: 'object', minProperties: 1 },
    current: { type: 'boolean' }
  },
  required: [
    'leftClaimId',
    'rightClaimId',
    'leftVersion',
    'rightVersion',
    'survivorClaimId',
    'values'
  ],
  additionalProperties: false
} as const;

export type ConfirmClaimMergeBody = FromSchema<
  typeof confirmClaimMergeBodySchema
>;

const claimBatchActionSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['accept_claim', 'merge_claims', 'merge_claim_group']
    },
    claimId: { type: 'string', format: 'uuid' },
    version: { type: 'integer', minimum: 1 },
    leftClaimId: { type: 'string', format: 'uuid' },
    rightClaimId: { type: 'string', format: 'uuid' },
    leftVersion: { type: 'integer', minimum: 1 },
    rightVersion: { type: 'integer', minimum: 1 },
    claims: {
      type: 'array',
      minItems: 2,
      maxItems: 100,
      uniqueItems: true,
      items: {
        type: 'object',
        properties: {
          claimId: { type: 'string', format: 'uuid' },
          version: { type: 'integer', minimum: 1 }
        },
        required: ['claimId', 'version'],
        additionalProperties: false
      }
    },
    survivorClaimId: { type: 'string', format: 'uuid' },
    values: { type: 'object', minProperties: 1 },
    current: { type: 'boolean' }
  },
  required: ['action'],
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: { action: { const: 'accept_claim' } },
        required: ['action']
      },
      then: {
        required: ['claimId', 'version'],
        not: {
          anyOf: [
            { required: ['leftClaimId'] },
            { required: ['rightClaimId'] },
            { required: ['leftVersion'] },
            { required: ['rightVersion'] },
            { required: ['survivorClaimId'] },
            { required: ['values'] },
            { required: ['current'] },
            { required: ['claims'] }
          ]
        }
      }
    },
    {
      if: {
        properties: { action: { const: 'merge_claims' } },
        required: ['action']
      },
      then: {
        required: [
          'leftClaimId',
          'rightClaimId',
          'leftVersion',
          'rightVersion',
          'survivorClaimId',
          'values'
        ],
        not: {
          anyOf: [
            { required: ['claimId'] },
            { required: ['version'] },
            { required: ['claims'] }
          ]
        }
      }
    },
    {
      if: {
        properties: { action: { const: 'merge_claim_group' } },
        required: ['action']
      },
      then: {
        required: ['claims', 'survivorClaimId', 'values'],
        not: {
          anyOf: [
            { required: ['claimId'] },
            { required: ['version'] },
            { required: ['leftClaimId'] },
            { required: ['rightClaimId'] },
            { required: ['leftVersion'] },
            { required: ['rightVersion'] }
          ]
        }
      }
    }
  ]
} as const;

export const resolveClaimBatchBodySchema = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: claimBatchActionSchema
    }
  },
  required: ['actions'],
  additionalProperties: false
} as const;

export type ClaimBatchResolutionAction =
  | {
      action: 'accept_claim';
      claimId: string;
      version: number;
    }
  | {
      action: 'merge_claims';
      leftClaimId: string;
      rightClaimId: string;
      leftVersion: number;
      rightVersion: number;
      survivorClaimId: string;
      values: unknown;
      current?: boolean;
    }
  | {
      action: 'merge_claim_group';
      claims: Array<{ claimId: string; version: number }>;
      survivorClaimId: string;
      values: unknown;
      current?: boolean;
    };

export interface ResolveClaimBatchBody {
  actions: ClaimBatchResolutionAction[];
}

export const reviewClaimBodySchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['accepted', 'rejected'] }
  },
  required: ['status'],
  additionalProperties: false
} as const;

export type ReviewClaimBody = FromSchema<typeof reviewClaimBodySchema>;

// Acknowledging an auto-merge carries no body: the claim id is in the path.
export const acknowledgeAutoMergeBodySchema = {
  type: 'object',
  additionalProperties: false
} as const;

export type AcknowledgeAutoMergeBody = FromSchema<
  typeof acknowledgeAutoMergeBodySchema
>;

export const listClaimsQuerySchema = {
  type: 'object',
  properties: {
    type: claimTypeSchema,
    status: claimStatusSchema
  },
  additionalProperties: false
} as const;

export type ListClaimsQuery = FromSchema<typeof listClaimsQuerySchema>;
