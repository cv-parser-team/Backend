import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { config } from '../../config/config.js';
import { createUnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import {
  createGeminiLlmClient,
  createLlmRepository,
  createLlmService
} from '../../infrastructure/llm/index.js';
import { createCandidateExtractionWriter } from '../candidates/index.js';
import {
  createCandidateExtractionService,
  createExtractionPersistenceCoordinator,
  type CandidateExtractionService
} from '../extraction/index.js';
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
  const unitOfWork = createUnitOfWork(fastify.database);
  let candidateExtractionService: CandidateExtractionService | undefined;
  const lazyCandidateExtractionService: CandidateExtractionService = {
    extract(request) {
      candidateExtractionService ??= createCandidateExtractionService({
        llmService: createLlmService(
          createGeminiLlmClient({
            apiKey: config.llm.apiKey,
            maximumInputCharacters: config.llm.maximumInputCharacters
          }),
          createLlmRepository(fastify.database)
        ),
        provider: config.llm.provider,
        model: config.llm.model,
        timeoutMs: config.llm.timeoutMs
      });
      return candidateExtractionService.extract(request);
    }
  };
  const extractionPersistenceCoordinator =
    createExtractionPersistenceCoordinator({
      candidateWriter: createCandidateExtractionWriter(fastify.database),
      parsingService: fastify.parsingService,
      unitOfWork
    });

  fastify.decorate('documentProcessingService', service);
  fastify.decorate(
    'parseDocumentHandler',
    createParseDocumentHandler({
      documentsService: fastify.processingDocumentsService,
      parsingService: fastify.parsingService,
      candidateExtractionService: lazyCandidateExtractionService,
      extractionPersistenceCoordinator,
      processingService: service,
      unitOfWork
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
