import { FastifyPluginAsync } from 'fastify';
import { createUsersRepository } from './users.repository.js';
import { usersRoutes } from './users.routes.js';
import { createUsersService } from './users.service.js';

export const usersModule: FastifyPluginAsync = async (fastify) => {
  const repository = createUsersRepository(fastify.database);
  const service = createUsersService(repository);

  await fastify.register(usersRoutes, { service });
};
