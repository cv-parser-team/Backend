import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { config } from '../../config/config.js';
import { createDocumentsRepository } from './documents.repository.js';
import { documentsRoutes } from './documents.routes.js';
import { createDocumentsService } from './documents.service.js';
import { createLocalDocumentStorage } from './documents.storage.js';
import { createDocumentValidator } from './documents.validator.js';

const registerDocuments: FastifyPluginAsync = async (fastify) => {
  const repository = createDocumentsRepository(fastify.database);
  const storage = createLocalDocumentStorage({
    storageRoot: config.documents.storageRoot,
    maximumByteSize: config.documents.maximumUploadByteSize
  });
  const validator = createDocumentValidator();
  const service = createDocumentsService({ repository, storage, validator });

  fastify.addHook('onListen', async () => {
    try {
      const cleanup = await service.cleanupDeletingDocuments();

      if (cleanup.deleted > 0) {
        fastify.log.info(
          { deletedDocuments: cleanup.deleted },
          'Cleaned up documents left in deleting status'
        );
      }

      for (const failure of cleanup.failures) {
        fastify.log.warn(
          { err: failure.error, documentId: failure.documentId },
          'Failed to clean up document left in deleting status'
        );
      }
    } catch (error) {
      fastify.log.warn(
        { err: error },
        'Failed to query documents left in deleting status'
      );
    }
  });

  await fastify.register(multipart, {
    limits: {
      fields: 0,
      files: config.documents.maximumUploadFiles,
      parts: config.documents.maximumUploadFiles,
      fieldNameSize: 100,
      fileSize: config.documents.maximumUploadByteSize
    }
  });

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
