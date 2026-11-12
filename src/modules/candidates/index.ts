import { FastifyPluginAsync } from 'fastify';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import {
  createCandidateExtractionWriter as createWriter,
  type CandidateExtractionWriter
} from './candidates.extraction-writer.js';
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
  database: AppDatabase
): CandidateExtractionWriter {
  return createWriter({ repository: createCandidatesRepository(database) });
}

export type {
  CandidateExtractionWriter,
  ExtractedClaimDraftInput
} from './candidates.extraction-writer.js';
