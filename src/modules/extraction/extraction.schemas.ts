import { FromSchema } from 'json-schema-to-ts';

// The contract the AI must follow when it returns what it extracted from a CV.
// Increase the version when the shape changes, so older outputs can be told
// apart.
export const AI_OUTPUT_VERSION = 1;

export const CLAIM_TYPES = [
  'skill',
  'employment',
  'education',
  'certification',
  'language',
  'project'
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

// A line reference from the parsing AI input: "L12", "L5-7", "L39-41,44" for
// PDF lines, or "B3" and "B4.1" for DOCX blocks and table rows.
const referenceSchema = {
  type: 'string',
  pattern: '^(L\\d+(-\\d+)?(,\\d+(-\\d+)?)*|B\\d+(\\.\\d+)?)$'
} as const;

// Every value must point to the lines it came from, so nothing is invented.
const sourcesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: referenceSchema
} as const;

// One extracted value with its evidence. `raw` keeps the text as the CV wrote
// it, such as "Oct 2023". An end date written as "Present" has no value and
// `current: true`. Confidence is given per field, so a doubtful value can be
// reviewed on its own without doubting the rest of the claim.
export const extractedFieldSchema = {
  type: 'object',
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    value: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 5000 },
        {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: 100 }
        }
      ]
    },
    raw: { type: 'string', minLength: 1, maxLength: 5000 },
    current: { type: 'boolean' },
    sources: sourcesSchema
  },
  required: ['confidence', 'sources'],
  additionalProperties: false
} as const;

export type ExtractedField = FromSchema<typeof extractedFieldSchema>;

export const extractedClaimSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: CLAIM_TYPES },
    fields: {
      type: 'object',
      maxProperties: 20,
      additionalProperties: extractedFieldSchema
    }
  },
  required: ['type', 'fields'],
  additionalProperties: false
} as const;

export type ExtractedClaim = FromSchema<typeof extractedClaimSchema>;

export const extractedProfileSchema = {
  type: 'object',
  properties: {
    fullName: extractedFieldSchema,
    headline: extractedFieldSchema,
    summary: extractedFieldSchema,
    phone: extractedFieldSchema,
    location: extractedFieldSchema,
    contactEmail: extractedFieldSchema,
    // `value` is the URL and `raw` the link text, such as "LinkedIn".
    links: { type: 'array', maxItems: 20, items: extractedFieldSchema }
  },
  additionalProperties: false
} as const;

export type ExtractedProfile = FromSchema<typeof extractedProfileSchema>;

export const extractedUnmappedSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 200 },
    text: { type: 'string', minLength: 1, maxLength: 5000 },
    sources: sourcesSchema
  },
  required: ['label', 'text', 'sources'],
  additionalProperties: false
} as const;

export type ExtractedUnmapped = FromSchema<typeof extractedUnmappedSchema>;

// The configured Gemini model rejects the complete nested contract as too
// complex. Provider generation therefore enforces the stable envelope and
// item containers only. The prompt describes the detailed contract, and the
// local validators below remain authoritative for fields, values, and sources.
const generatedFieldSchema = {
  type: 'object',
  properties: {
    value: {
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } }
      ]
    },
    raw: { type: 'string' },
    current: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    sources: { type: 'array', items: { type: 'string' } }
  },
  required: ['confidence', 'sources'],
  additionalProperties: false
} as const;

export const aiGenerationSchema = {
  type: 'object',
  properties: {
    version: { type: 'integer' },
    profile: {
      type: 'object',
      properties: {
        fullName: generatedFieldSchema,
        headline: generatedFieldSchema,
        summary: generatedFieldSchema,
        phone: generatedFieldSchema,
        location: generatedFieldSchema,
        contactEmail: generatedFieldSchema,
        links: { type: 'array', items: generatedFieldSchema }
      },
      additionalProperties: false
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          fields: {
            type: 'object',
            additionalProperties: generatedFieldSchema
          }
        },
        required: ['type', 'fields'],
        additionalProperties: false
      }
    },
    unmapped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          text: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } }
        },
        required: ['label', 'text', 'sources'],
        additionalProperties: false
      }
    }
  },
  required: ['version', 'profile', 'claims', 'unmapped'],
  additionalProperties: false
} as const;

// Only the envelope is checked as a whole. Each claim, profile, and unmapped
// item is checked on its own, so one invalid item never rejects the others.
export const aiOutputEnvelopeSchema = {
  type: 'object',
  properties: {
    version: { const: AI_OUTPUT_VERSION },
    profile: { type: 'object' },
    claims: { type: 'array', maxItems: 500 },
    unmapped: { type: 'array', maxItems: 500 }
  },
  required: ['version', 'claims'],
  additionalProperties: false
} as const;
