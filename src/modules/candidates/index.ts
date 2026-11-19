import { FastifyPluginAsync } from 'fastify';
import type { AppDatabase } from '../../infrastructure/database/database.js';
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
