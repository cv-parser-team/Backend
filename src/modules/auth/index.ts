import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { AuthGuards, createAuthGuards } from './auth.guards.js';
import { createAuthRepository } from './auth.repository.js';
import { authRoutes } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createJwtService } from './jwt-service.js';
import {
  createPasswordHasher,
  DUMMY_PASSWORD_HASH
} from './password-hasher.js';

declare module 'fastify' {
  interface FastifyInstance {
    authGuards: AuthGuards;
  }
}

const registerAuth: FastifyPluginAsync = async (fastify) => {
  const repository = createAuthRepository(fastify.database);
  const passwordHasher = createPasswordHasher();
  const jwtService = createJwtService();
  const service = createAuthService({
    repository,
    passwordHasher,
    jwtService,
    dummyPasswordHash: DUMMY_PASSWORD_HASH
  });
  const guards = createAuthGuards({ repository, jwtService });

  fastify.decorate('authGuards', guards);
  await fastify.register(authRoutes, {
    prefix: '/api/auth',
    service,
    guards
  });
};

export const authModule = fastifyPlugin(registerAuth, {
  name: 'auth',
  dependencies: ['database']
});
