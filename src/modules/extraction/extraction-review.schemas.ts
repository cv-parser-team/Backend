import { FromSchema } from 'json-schema-to-ts';

export const EXTRACTION_REVIEW_ISSUE_CODES = [
  'invalid_item',
  'invalid_source',
  'missing_value',
  'invalid_value',
  'invalid_date',
  'invalid_date_order',
  'missing_name',
  'missing_employer',
  'missing_job_title',
  'missing_start_date',
  'missing_institution',
  'missing_degree',
  'missing_title',
  'missing_issuer',
  'missing_issue_date'
] as const;

export const listExtractionReviewItemsQuerySchema = {
  type: 'object',
  properties: {
    documentId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['pending', 'resolved', 'dismissed'],
      default: 'pending'
    }
  },
  additionalProperties: false
} as const;

export type ListExtractionReviewItemsQuery = FromSchema<
  typeof listExtractionReviewItemsQuerySchema
>;

const reviewIssueSchema = {
  type: 'object',
  properties: {
    field: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    code: { type: 'string', enum: EXTRACTION_REVIEW_ISSUE_CODES },
    required: { type: 'boolean' }
  },
  required: ['field', 'code', 'required'],
  additionalProperties: false
} as const;

const extractionReviewItemProperties = {
  reviewItemId: { type: 'string', format: 'uuid' },
  documentId: { type: 'string', format: 'uuid' },
  claimType: {
    type: 'string',
    enum: ['skill', 'employment', 'education', 'certification', 'language', 'project']
  },
  fields: { type: 'object', additionalProperties: true },
  issues: { type: 'array', items: reviewIssueSchema },
  sources: { type: 'array', items: { type: 'string' } },
  resolvedClaimId: {
    anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }]
  },
  version: { type: 'integer', minimum: 1 }
} as const;

const extractionReviewItemRequired = [
  'reviewItemId',
  'documentId',
  'claimType',
  'fields',
  'issues',
  'sources',
  'status',
  'resolvedClaimId',
  'version'
] as const;

const extractionReviewItemSchema = {
  type: 'object',
  properties: {
    ...extractionReviewItemProperties,
    status: {
      type: 'string',
      enum: ['pending', 'resolved', 'dismissed']
    },
    possibleDuplicates: {
      type: 'object',
      properties: {
        claimIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
        reviewItemIds: { type: 'array', items: { type: 'string', format: 'uuid' } }
      },
      required: ['claimIds', 'reviewItemIds'],
      additionalProperties: false
    }
  },
  required: extractionReviewItemRequired,
  additionalProperties: false
} as const;

export const listExtractionReviewItemsResponseSchema = {
  type: 'object',
  properties: {
    success: { const: true },
    data: { type: 'array', items: extractionReviewItemSchema },
    timestamp: { type: 'string', format: 'date-time' }
  },
  required: ['success', 'data', 'timestamp'],
  additionalProperties: false
} as const;

export const extractionReviewItemParamsSchema = {
  type: 'object',
  properties: {
    reviewItemId: { type: 'string', format: 'uuid' }
  },
  required: ['reviewItemId'],
  additionalProperties: false
} as const;

export type ExtractionReviewItemParams = FromSchema<
  typeof extractionReviewItemParamsSchema
>;

export const resolveExtractionReviewItemBodySchema = {
  type: 'object',
  properties: {
    values: { type: 'object', minProperties: 1, additionalProperties: true }
  },
  required: ['values'],
  additionalProperties: false
} as const;

export type ResolveExtractionReviewItemBody = FromSchema<
  typeof resolveExtractionReviewItemBodySchema
>;

export const dismissExtractionReviewItemResponseSchema = {
  type: 'object',
  properties: {
    success: { const: true },
    data: {
      type: 'object',
      properties: {
        ...extractionReviewItemProperties,
        status: { const: 'dismissed' }
      },
      required: extractionReviewItemRequired,
      additionalProperties: false
    },
    message: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' }
  },
  required: ['success', 'data', 'message', 'timestamp'],
  additionalProperties: false
} as const;

const resolvedReviewItemSchema = {
  type: 'object',
  properties: {
    ...extractionReviewItemProperties,
    status: { const: 'resolved' },
    resolvedClaimId: { type: 'string', format: 'uuid' }
  },
  required: extractionReviewItemRequired,
  additionalProperties: false
} as const;

const resolvedClaimSchema = {
  type: 'object',
  properties: {
    claimId: { type: 'string', format: 'uuid' },
    claimType: extractionReviewItemProperties.claimType,
    origin: { const: 'extracted' },
    status: { const: 'accepted' },
    values: { type: 'object', additionalProperties: true },
    extraction: {
      type: 'object',
      properties: {
        invocationId: { type: 'string', format: 'uuid' },
        sourceDocumentId: { type: 'string', format: 'uuid' },
        rawValues: { type: 'object', additionalProperties: { type: 'string' } },
        fieldSources: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        current: { type: 'boolean' }
      },
      required: [
        'invocationId',
        'sourceDocumentId',
        'rawValues',
        'fieldSources',
        'current'
      ],
      additionalProperties: false
    },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' }
  },
  required: [
    'claimId',
    'claimType',
    'origin',
    'status',
    'values',
    'extraction',
    'version',
    'createdAt',
    'updatedAt'
  ],
  additionalProperties: false
} as const;

export const resolveExtractionReviewItemResponseSchema = {
  type: 'object',
  properties: {
    success: { const: true },
    data: {
      type: 'object',
      properties: {
        reviewItem: resolvedReviewItemSchema,
        claim: resolvedClaimSchema
      },
      required: ['reviewItem', 'claim'],
      additionalProperties: false
    },
    message: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' }
  },
  required: ['success', 'data', 'message', 'timestamp'],
  additionalProperties: false
} as const;
