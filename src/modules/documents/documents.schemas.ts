import { FromSchema } from 'json-schema-to-ts';

export const listDocumentsQuerySchema = {
  type: 'object',
  properties: {
    purpose: { type: 'string', enum: ['source', 'evidence'] },
    status: {
      type: 'string',
      enum: ['stored', 'processing', 'ready', 'failed', 'deleting']
    }
  },
  additionalProperties: false
} as const;

export type ListDocumentsQuery = FromSchema<
  typeof listDocumentsQuerySchema
>;

export const documentParamsSchema = {
  type: 'object',
  properties: {
    documentId: { type: 'string', format: 'uuid' }
  },
  required: ['documentId'],
  additionalProperties: false
} as const;

export type DocumentParams = FromSchema<typeof documentParamsSchema>;
