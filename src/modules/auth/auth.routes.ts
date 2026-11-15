import { FastifyPluginAsync } from 'fastify';
import { ApiResponse } from '../../shared/http/api-response.js';
import { AuthGuards } from './auth.guards.js';
import {
  RegisterBody,
  registerBodySchema,
  SignInBody,
  signInBodySchema
} from './auth.schemas.js';
import { AuthResult, AuthService } from './auth.service.js';

export interface AuthRoutesOptions {
  service: AuthService;
  guards: AuthGuards;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  { service, guards }
) => {
  fastify.post<{ Body: RegisterBody }>(
    '/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Register a candidate',
        description: 'Creates a candidate account and returns a JWT access token.',
        body: registerBodySchema,
        response: {
          201: {
            description: 'Candidate registered successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: {
                type: 'object',
                properties: {
                  userId: { type: 'string', format: 'uuid' },
                  accessToken: { type: 'string' }
                },
                required: ['userId', 'accessToken'],
                additionalProperties: false
              },
              message: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' }
            },
            required: ['success', 'data', 'message', 'timestamp'],
            additionalProperties: false
          },
          400: {
            description: 'Invalid registration details',
            type: 'object',
            additionalProperties: true
          },
          409: {
            description: 'An account with the email already exists',
            type: 'object',
            additionalProperties: true
          }
        }
      }
    },
    async (request, reply) => {
      const data = await service.register(request.body);
      const response: ApiResponse<AuthResult> = {
        success: true,
        data,
        message: 'Candidate registered successfully',
        timestamp: new Date().toISOString()
      };

      return reply.status(201).send(response);
    }
  );

  fastify.post<{ Body: SignInBody }>(
    '/sign-in',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in',
        description: 'Authenticates a user and returns a JWT access token.',
        body: signInBodySchema,
        response: {
          200: {
            description: 'Signed in successfully',
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: {
                type: 'object',
                properties: {
                  userId: { type: 'string', format: 'uuid' },
                  accessToken: { type: 'string' }
                },
                required: ['userId', 'accessToken'],
                additionalProperties: false
              },
              message: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' }
            },
            required: ['success', 'data', 'message', 'timestamp'],
            additionalProperties: false
          },
          400: {
            description: 'Invalid sign-in details',
            type: 'object',
            additionalProperties: true
          },
          401: {
            description: 'Invalid email or password',
            type: 'object',
            additionalProperties: true
          },
          403: {
            description: 'Account is not active',
            type: 'object',
            additionalProperties: true
          }
        }
      }
    },
    async (request) => {
      const data = await service.signIn(request.body);
      const response: ApiResponse<AuthResult> = {
        success: true,
        data,
        message: 'Signed in successfully',
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.post(
    '/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log out',
        description: 'Invalidates all access tokens previously issued to the user.',
        security: [{ bearerAuth: [] }],
        response: {
          204: {
            description: 'Logged out successfully',
            type: 'object',
            additionalProperties: true
          },
          401: {
            description: 'Authentication required or token is invalid',
            type: 'object',
            additionalProperties: true
          },
          403: {
            description: 'Account is not active',
            type: 'object',
            additionalProperties: true
          }
        }
      },
      preHandler: [guards.authenticate, guards.requireActiveAccount]
    },
    async (request, reply) => {
      await service.logout(request.auth.userId);
      return reply.status(204).send();
    }
  );
};
