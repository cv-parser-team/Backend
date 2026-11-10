import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createNormalizationRepository } from './normalization.repository.js';
import { createNormalizationService, NormalizationService } from './normalization.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    normalizationService: NormalizationService;
  }
}

const registerNormalization: FastifyPluginAsync = async (fastify) => {
  const repository = createNormalizationRepository(fastify.database);
  fastify.decorate('normalizationService', createNormalizationService({ repository }));
};

export const normalizationModule = fastifyPlugin(registerNormalization, {
  name: 'normalization',
  dependencies: ['database']
});
