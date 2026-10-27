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

export const usersRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (
  fastify,
  { service, guards }
) => {
  fastify.get(
    '/',
    {
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
      schema: { params: getUserParamsSchema },
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
