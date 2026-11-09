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
// `current: true`.
export const extractedFieldSchema = {
  type: 'object',
  properties: {
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
  required: ['sources'],
  additionalProperties: false
} as const;

export type ExtractedField = FromSchema<typeof extractedFieldSchema>;

export const extractedClaimSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: CLAIM_TYPES },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    fields: {
      type: 'object',
      maxProperties: 20,
      additionalProperties: extractedFieldSchema
    }
  },
  required: ['type', 'confidence', 'fields'],
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
