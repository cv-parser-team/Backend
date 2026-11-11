import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { createDocumentProcessingRepository } from './document-processing.repository.js';
import {
  createDocumentProcessingService,
  DocumentProcessingService
} from './document-processing.service.js';
import {
  createParseDocumentHandler,
  ParseDocumentHandler
} from './parse-document.handler.js';

declare module 'fastify' {
  interface FastifyInstance {
    documentProcessingService: DocumentProcessingService;
    parseDocumentHandler: ParseDocumentHandler;
  }
}

const registerDocumentProcessing: FastifyPluginAsync = async (fastify) => {
  const repository = createDocumentProcessingRepository(fastify.database);
  const service = createDocumentProcessingService({
    broker: fastify.messageBroker,
    repository
  });

  fastify.decorate('documentProcessingService', service);
  fastify.decorate(
    'parseDocumentHandler',
    createParseDocumentHandler({
      documentsService: fastify.processingDocumentsService,
      parsingService: fastify.parsingService,
      processingService: service
    })
  );
};

export const documentProcessingModule = fastifyPlugin(
  registerDocumentProcessing,
  {
    name: 'document-processing',
    dependencies: ['database', 'messaging', 'documents', 'parsing']
  }
);

export {
  PARSE_DOCUMENT_JOB_VERSION,
  PARSE_DOCUMENT_QUEUE,
  parseParseDocumentJob
} from './parse-document.job.js';
export { createParseDocumentHandler } from './parse-document.handler.js';
export {
  createParseDocumentMessageHandler
} from './parse-document.message-handler.js';
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
export type {
  ParseDocumentMessageHandlerDependencies,
  ParseDocumentMessageLogger
} from './parse-document.message-handler.js';
export type { ParseDocumentJob } from './parse-document.job.js';
