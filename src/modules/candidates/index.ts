import { FastifyPluginAsync } from 'fastify';
import { createCandidatesRepository } from './candidates.repository.js';
import { candidatesRoutes } from './candidates.routes.js';
import { createCandidatesService } from './candidates.service.js';

export const candidatesModule: FastifyPluginAsync = async (fastify) => {
  const repository = createCandidatesRepository(fastify.database);
  const service = createCandidatesService({
    repository,
    usersService: fastify.usersService,
    normalizer: fastify.normalizationService,
    logger: fastify.log
  });

  await fastify.register(candidatesRoutes, {
    service,
    guards: fastify.authGuards
  });
};
