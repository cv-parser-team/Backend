import { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { config } from '../../config/config.js';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import {
  createGeminiLlmClient,
  createLlmRepository,
  createLlmService
} from '../../infrastructure/llm/index.js';
import type { UsersService } from '../users/users.service.js';
import {
  createCandidateExtractionWriter as createWriter,
  type CandidateExtractionWriter,
  type ExtractionTermLookup
} from './candidates.extraction-writer.js';
import {
  createCandidateEntityMatcher as createMatcher,
  type CandidateEntityMatcher
} from './candidates.entity-matcher.js';
import { createCandidatesRepository } from './candidates.repository.js';
import { candidatesRoutes } from './candidates.routes.js';
import { createCandidatesService } from './candidates.service.js';
import { createDuplicateJudge, type DuplicateJudge } from './candidates.duplicate-ai.js';

export const candidatesModule: FastifyPluginAsync = async (fastify) => {
  const repository = createCandidatesRepository(fastify.database);
  const aiEnabled = config.candidates.duplicateAiEnabled && Boolean(config.llm.apiKey);
  let duplicateJudge: DuplicateJudge | undefined;
  const lazyDuplicateJudge: DuplicateJudge = {
    judge(left, right) {
      duplicateJudge ??= createDuplicateJudge({
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
      return duplicateJudge.judge(left, right);
    }
  };
  const service = createCandidatesService({
    repository,
    usersService: fastify.usersService,
    normalizer: fastify.normalizationService,
    logger: fastify.log,
    ...(aiEnabled ? { duplicateJudge: lazyDuplicateJudge } : {})
  });

  await fastify.register(candidatesRoutes, {
    service,
    guards: fastify.authGuards
  });
};

// Public composition boundary for background extraction. The repository stays
// private to this module.
export function createCandidateExtractionWriter(
  database: AppDatabase,
  termLookup?: ExtractionTermLookup
): CandidateExtractionWriter {
  return createWriter({
    repository: createCandidatesRepository(database),
    ...(termLookup ? { termLookup } : {})
  });
}

// Public boundary for finding which claims an unsaved fact, such as an
// extracted value awaiting review, may state again.
export function createCandidateEntityMatcher(
  database: AppDatabase,
  termLookup?: ExtractionTermLookup
): CandidateEntityMatcher {
  return createMatcher({
    repository: createCandidatesRepository(database),
    ...(termLookup ? { termLookup } : {})
  });
}

// Background processing needs only the safe post-extraction duplicate scan,
// not the HTTP plugin. Keep that composition inside this module so workers do
// not need to register candidate routes to access it.
export function createCandidateAutoMergeRunner(
  database: AppDatabase,
  usersService: Pick<UsersService, 'getUserById'>,
  normalizer: Parameters<typeof createCandidatesService>[0]['normalizer'],
  logger: Pick<FastifyBaseLogger, 'warn'>
): Pick<ReturnType<typeof createCandidatesService>, 'autoAcceptHighConfidenceDuplicates'> {
  const service = createCandidatesService({
    repository: createCandidatesRepository(database),
    usersService,
    normalizer,
    logger
  });
  return {
    autoAcceptHighConfidenceDuplicates:
      service.autoAcceptHighConfidenceDuplicates
  };
}

export type {
  CandidateEntityMatcher,
  SameEntityMatches,
  UnsavedEntityInput
} from './candidates.entity-matcher.js';
export type {
  CandidateExtractionWriter,
  ExtractedClaimDraftInput,
  ExtractedClaimSourceOccurrenceInput,
  ResolvedExtractionClaimInput
} from './candidates.extraction-writer.js';
export { ConflictingSourceOccurrenceError } from './candidates.extraction-writer.js';
