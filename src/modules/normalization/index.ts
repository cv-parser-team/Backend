import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { config } from '../../config/config.js';
import { createUnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import {
  createGeminiLlmClient,
  createLlmRepository,
  createLlmService
} from '../../infrastructure/llm/index.js';
import {
  type AiRequestRepository,
  createAiRequestRepository
} from './normalization-ai-requests.repository.js';
import { type AiRequestProcessor, createAiRequestProcessor } from './normalization.ai-processor.js';
import { type AiMatcher, createAiMatcher } from './normalization.ai.js';
import { createNormalizationRepository } from './normalization.repository.js';
import { createNormalizationService, NormalizationService } from './normalization.service.js';

// What the worker needs to process AI requests in the background.
export interface NormalizationAi {
  enabled: boolean;
  requests: Pick<AiRequestRepository, 'claimBatch'>;
  processor: AiRequestProcessor;
}

declare module 'fastify' {
  interface FastifyInstance {
    normalizationService: NormalizationService;
    normalizationAi: NormalizationAi;
  }
}

const registerNormalization: FastifyPluginAsync = async (fastify) => {
  const repository = createNormalizationRepository(fastify.database);
  const aiRequests = createAiRequestRepository(fastify.database);
  const aiEnabled = config.normalization.aiEnabled && Boolean(config.llm.apiKey);

  // The LLM client is created on first use, so the API, tests, and a missing
  // key never need provider credentials.
  let matcher: AiMatcher | undefined;
  const lazyMatcher: AiMatcher = {
    match(request) {
      matcher ??= createAiMatcher({
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
      return matcher.match(request);
    }
  };

  fastify.decorate(
    'normalizationService',
    createNormalizationService({
      repository,
      aiRequests: aiEnabled ? aiRequests : undefined
    })
  );
  fastify.decorate('normalizationAi', {
    enabled: aiEnabled,
    requests: aiRequests,
    processor: createAiRequestProcessor({
      dictionary: repository,
      decisions: repository,
      requests: aiRequests,
      matcher: lazyMatcher,
      unitOfWork: createUnitOfWork(fastify.database)
    })
  });
};

export const normalizationModule = fastifyPlugin(registerNormalization, {
  name: 'normalization',
  dependencies: ['database']
});
