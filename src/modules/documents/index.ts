import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { config } from '../../config/config.js';
import { createDocumentsRepository } from './documents.repository.js';
import { documentsRoutes } from './documents.routes.js';
import {
  createDocumentsService,
  type DocumentsService,
  type ProcessingDocumentsService
} from './documents.service.js';
import { createLocalDocumentStorage } from './documents.storage.js';
import { createDocumentValidator } from './documents.validator.js';

declare module 'fastify' {
  interface FastifyInstance {
    candidateDocumentsService: Pick<
      DocumentsService,
      'getDocument' | 'listDocuments'
    >;
    processingDocumentsService: ProcessingDocumentsService;
  }
}

const registerDocuments: FastifyPluginAsync = async (fastify) => {
  const repository = createDocumentsRepository(fastify.database);
  const storage = createLocalDocumentStorage({
    storageRoot: config.documents.storageRoot,
    maximumByteSize: config.documents.maximumUploadByteSize
  });
  const validator = createDocumentValidator();
  const service = createDocumentsService({ repository, storage, validator });

  fastify.decorate('processingDocumentsService', service);
  fastify.decorate('candidateDocumentsService', service);

  fastify.addHook('onListen', async () => {
    const stagingCutoff = new Date(
      Date.now() - config.documents.stagingMaximumAgeSeconds * 1000
    );
    const orphanCutoff = new Date(
      Date.now() - config.documents.orphanGracePeriodSeconds * 1000
    );

    try {
      const deletedStagedFiles = await storage.cleanupStaged(stagingCutoff);

      if (deletedStagedFiles > 0) {
        fastify.log.info(
          { deletedStagedFiles },
          'Cleaned up stale staged documents'
        );
      }
    } catch (error) {
      fastify.log.warn({ err: error }, 'Failed to clean up staged documents');
    }

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

    try {
      const cleanup = await service.cleanupOrphanedObjects(orphanCutoff);

      if (cleanup.deleted > 0) {
        fastify.log.info(
          { deletedOrphanedObjects: cleanup.deleted },
          'Cleaned up orphaned document objects'
        );
      }

      for (const failure of cleanup.failures) {
        fastify.log.warn(
          { err: failure.error, storageKey: failure.storageKey },
          'Failed to clean up orphaned document object'
        );
      }
    } catch (error) {
      fastify.log.warn(
        { err: error },
        'Failed to reconcile document objects with metadata'
      );
    }
  });

  await fastify.register(multipart, {
    limits: {
      fields: 0,
      files: config.documents.maximumUploadFiles,
      parts: config.documents.maximumUploadFiles + 1,
      fieldNameSize: 100,
      fileSize: config.documents.maximumUploadByteSize
    }
  });

  await fastify.register(documentsRoutes, {
    prefix: '/api/candidates/me/documents',
    service,
    processingScheduler: {
      async schedule(documentId) {
        await fastify.documentProcessingService.schedule(documentId);
      }
    },
    guards: fastify.authGuards,
    maximumUploadFiles: config.documents.maximumUploadFiles
  });
};

export const documentsModule = fastifyPlugin(registerDocuments, {
  name: 'documents',
  dependencies: ['database', 'auth']
});

export type {
  DocumentsService,
  DocumentContent,
  ProcessingDocumentsService
} from './documents.service.js';
