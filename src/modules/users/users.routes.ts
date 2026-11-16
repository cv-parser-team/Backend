import { FastifyPluginAsync } from 'fastify';
import { AuthGuards } from '../auth/auth.guards.js';
import { ApiResponse } from '../../shared/http/api-response.js';
import { SafeUser, UsersService } from './users.service.js';
import {
  getUserParamsSchema,
  GetUserParams
} from './users.schemas.js';

interface UsersRoutesOptions {
  service: UsersService;
  guards: AuthGuards;
}

function documentedResponse(description: string) {
  return {
    description,
    type: 'object',
    additionalProperties: true
  } as const;
}

const userSecurity = [{ bearerAuth: [] }];

export const usersRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (
  fastify,
  { service, guards }
) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Users'],
        summary: 'List users',
        description: 'Lists users for an active administrator.',
        security: userSecurity,
        response: {
          200: documentedResponse('Users'),
          401: documentedResponse('Authentication required or token is invalid'),
          403: documentedResponse('Administrator access required')
        }
      },
      preHandler: [
        guards.authenticate,
        guards.requireActiveAccount,
        guards.requireRole('admin')
      ]
    },
    async () => {
      const data = await service.listUsers();
      const response: ApiResponse<SafeUser[]> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };
      return response;
    }
  );

  fastify.get<{ Params: GetUserParams }>(
    '/:id',
    {
      schema: {
        tags: ['Users'],
        summary: 'Get a user',
        description: 'Returns the authenticated user or any user for an administrator.',
        security: userSecurity,
        params: getUserParamsSchema,
        response: {
          200: documentedResponse('User'),
          400: documentedResponse('Invalid user ID'),
          401: documentedResponse('Authentication required or token is invalid'),
          403: documentedResponse('Self or administrator access required'),
          404: documentedResponse('User not found')
        }
      },
      preHandler: [
        guards.authenticate,
        guards.requireActiveAccount,
        guards.requireSelfOrRole('id', 'admin')
      ]
    },
    async (request) => {
      const data = await service.getUserById(request.params.id);
      const response: ApiResponse<SafeUser> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };
      return response;
    }
  );
};
