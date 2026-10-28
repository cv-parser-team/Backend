import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createUsersRepository } from './users.repository.js';
import { usersRoutes } from './users.routes.js';
import { createUsersService, UsersService } from './users.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    usersService: UsersService;
  }
}

const registerUsers: FastifyPluginAsync = async (fastify) => {
  const repository = createUsersRepository(fastify.database);
  const service = createUsersService(repository);

  fastify.decorate('usersService', service);
  await fastify.register(usersRoutes, {
    prefix: '/api/users',
    service,
    guards: fastify.authGuards
  });
};

export const usersModule = fastifyPlugin(registerUsers, {
  name: 'users',
  dependencies: ['database', 'auth']
});
