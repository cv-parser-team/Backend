import { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth.routes.js';
import { createAuthRepository } from './auth.repository.js';
import { createAuthService } from './auth.service.js';
import { createJwtService } from './jwt-service.js';
import { createPasswordHasher } from './password-hasher.js';

export const authModule: FastifyPluginAsync = async (fastify) => {
  const repository = createAuthRepository(fastify.database);
  const passwordHasher = createPasswordHasher();
  const jwtService = createJwtService();
  const service = createAuthService({ repository, passwordHasher, jwtService });

  await fastify.register(authRoutes, { service });
};
