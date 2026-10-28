import { FromSchema } from 'json-schema-to-ts';

export const getUserParamsSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }
  },
  required: ['id'],
  additionalProperties: false
} as const;

export type GetUserParams = FromSchema<typeof getUserParamsSchema>;

export const createUserBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, pattern: '\\S' },
    email: { type: 'string', format: 'email' }
  },
  required: ['name', 'email'],
  additionalProperties: false
} as const;

export type CreateUserBody = FromSchema<typeof createUserBodySchema>;
