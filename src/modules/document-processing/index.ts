import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createDocumentProcessingRepository } from './document-processing.repository.js';
import {
  createDocumentProcessingService,
  DocumentProcessingService
} from './document-processing.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    documentProcessingService: DocumentProcessingService;
  }
}

const registerDocumentProcessing: FastifyPluginAsync = async (fastify) => {
  const repository = createDocumentProcessingRepository(fastify.database);
  const service = createDocumentProcessingService({
    broker: fastify.messageBroker,
    repository
  });

  fastify.decorate('documentProcessingService', service);

  fastify.addHook('onListen', async () => {
    try {
      const result = await service.republishQueuedJobs();

      if (result.published > 0) {
        fastify.log.info(
          { publishedJobs: result.published },
          'Republished queued document processing jobs'
        );
      }

      for (const failure of result.failures) {
        fastify.log.warn(
          { err: failure.error, jobId: failure.jobId },
          'Failed to republish queued document processing job'
        );
      }
    } catch (error) {
      fastify.log.warn(
        { err: error },
        'Failed to query queued document processing jobs'
      );
    }
  });
};

export const documentProcessingModule = fastifyPlugin(
  registerDocumentProcessing,
  {
    name: 'document-processing',
    dependencies: ['database', 'messaging']
  }
);

export {
  PARSE_DOCUMENT_JOB_VERSION,
  PARSE_DOCUMENT_QUEUE
} from './parse-document.job.js';
export { createParseDocumentHandler } from './parse-document.handler.js';
export type {
  DocumentProcessingService,
  RepublishFailure,
  RepublishResult
} from './document-processing.service.js';
export type {
  ParseDocumentHandler,
  ParseDocumentHandlerDependencies,
  ParseDocumentHandlerResult
} from './parse-document.handler.js';
export type { ParseDocumentJob } from './parse-document.job.js';
