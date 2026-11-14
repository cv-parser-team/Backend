import { FromSchema } from 'json-schema-to-ts';

export const listExtractionReviewItemsQuerySchema = {
  type: 'object',
  properties: {
    documentId: { type: 'string', format: 'uuid' }
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
    code: { type: 'string' },
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
  'version'
] as const;

const pendingExtractionReviewItemSchema = {
  type: 'object',
  properties: {
    ...extractionReviewItemProperties,
    status: { const: 'pending' }
  },
  required: extractionReviewItemRequired,
  additionalProperties: false
} as const;

export const listExtractionReviewItemsResponseSchema = {
  type: 'object',
  properties: {
    success: { const: true },
    data: { type: 'array', items: pendingExtractionReviewItemSchema },
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
