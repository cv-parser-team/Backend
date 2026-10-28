import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createDocumentsRepository } from './documents.repository.js';
import { documentsRoutes } from './documents.routes.js';
import { createDocumentsService } from './documents.service.js';

const registerDocuments: FastifyPluginAsync = async (fastify) => {
  const repository = createDocumentsRepository(fastify.database);
  const service = createDocumentsService(repository);

  await fastify.register(documentsRoutes, {
    prefix: '/api/candidates/me/documents',
    service,
    guards: fastify.authGuards
  });
};

export const documentsModule = fastifyPlugin(registerDocuments, {
  name: 'documents',
  dependencies: ['database', 'auth']
});
