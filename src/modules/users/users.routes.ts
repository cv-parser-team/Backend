import { FastifyPluginAsync } from 'fastify';
import { ApiResponse } from '../../shared/http/api-response.js';
import { SafeUser, UsersService } from './users.service.js';
import {
  createUserBodySchema,
  CreateUserBody,
  getUserParamsSchema,
  GetUserParams
} from './users.schemas.js';

interface UsersRoutesOptions {
  service: UsersService;
}

export const usersRoutes: FastifyPluginAsync<UsersRoutesOptions> = async (
  fastify,
  { service }
) => {
  fastify.get('/', async () => {
    const data = await service.listUsers();
    const response: ApiResponse<SafeUser[]> = {
      success: true,
      data,
      timestamp: new Date().toISOString()
    };
    return response;
  });

  fastify.get<{ Params: GetUserParams }>(
    '/:id',
    { schema: { params: getUserParamsSchema } },
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

  fastify.post<{ Body: CreateUserBody }>(
    '/',
    { schema: { body: createUserBodySchema } },
    async (request, reply) => {
      const data = await service.createUser(request.body);
      reply.status(201);
      const response: ApiResponse<SafeUser> = {
        success: true,
        data,
        message: 'User created successfully',
        timestamp: new Date().toISOString()
      };
      return response;
    }
  );
};
