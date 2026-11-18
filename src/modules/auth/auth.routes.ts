import { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/config.js';
import { ApiResponse } from '../../shared/http/api-response.js';
import { AuthGuards } from './auth.guards.js';
import {
  RegisterBody,
  registerBodySchema,
  SignInBody,
  signInBodySchema
} from './auth.schemas.js';
import { AuthResult, AuthService, AuthSession } from './auth.service.js';
import { REFRESH_TOKEN_TTL_SECONDS } from './jwt-service.js';

export const REFRESH_COOKIE_NAME = 'luminaCV_refresh';

function readRefreshToken(cookieHeader: string | undefined): string | undefined {
  const encoded = cookieHeader
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === REFRESH_COOKIE_NAME)
    ?.slice(1)
    .join('=');

  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function refreshCookie(token: string, maxAge = REFRESH_TOKEN_TTL_SECONDS): string {
  const secure = config.isProd ? '; Secure' : '';
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=${maxAge}${secure}`;
}

function publicResult(session: AuthSession): AuthResult {
  return { userId: session.userId, accessToken: session.accessToken };
}

function setRefreshCookie(reply: { header(name: string, value: string): unknown }, token: string): void {
  reply.header('Set-Cookie', refreshCookie(token));
  reply.header('Cache-Control', 'no-store');
}

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
      const session = await service.register(request.body);
      setRefreshCookie(reply, session.refreshToken);
      const data = publicResult(session);
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
    async (request, reply) => {
      const session = await service.signIn(request.body);
      setRefreshCookie(reply, session.refreshToken);
      const data = publicResult(session);
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
    '/refresh',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Refresh access token',
        description: 'Uses the HttpOnly refresh-token cookie to issue a new access token.',
        security: [{ refreshCookie: [] }],
        response: {
          200: {
            description: 'Access token refreshed successfully',
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
          401: {
            description: 'Refresh token is missing, invalid, expired, or revoked',
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
    async (request, reply) => {
      const session = await service.refresh(
        readRefreshToken(request.headers.cookie)
      );
      setRefreshCookie(reply, session.refreshToken);
      const response: ApiResponse<AuthResult> = {
        success: true,
        data: publicResult(session),
        message: 'Access token refreshed successfully',
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
      reply.header('Set-Cookie', refreshCookie('', 0));
      reply.header('Cache-Control', 'no-store');
      return reply.status(204).send();
    }
  );
};
