import { FromSchema } from 'json-schema-to-ts';

export const registerBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    email: { type: 'string', format: 'email', maxLength: 320 },
    password: { type: 'string', minLength: 8, maxLength: 128 }
  },
  required: ['name', 'email', 'password'],
  additionalProperties: false
} as const;

export type RegisterBody = FromSchema<typeof registerBodySchema>;

export const signInBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: 128 }
  },
  required: ['email', 'password'],
  additionalProperties: false
} as const;

export type SignInBody = FromSchema<typeof signInBodySchema>;
