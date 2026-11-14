import type { FastifyPluginAsync } from 'fastify';
import type { ApiResponse } from '../../shared/http/api-response.js';
import { parseIfMatchVersion, versionEtag } from '../../shared/http/if-match.js';
import type { AuthGuards } from '../auth/auth.guards.js';
import {
  dismissExtractionReviewItemResponseSchema,
  extractionReviewItemParamsSchema,
  listExtractionReviewItemsQuerySchema,
  listExtractionReviewItemsResponseSchema,
  type ExtractionReviewItemParams,
  type ListExtractionReviewItemsQuery
} from './extraction-review.schemas.js';
import type {
  ExtractionReviewItem,
  ExtractionReviewService
} from './extraction-review.service.js';

export interface ExtractionReviewRoutesOptions {
  service: ExtractionReviewService;
  guards: AuthGuards;
}

export const extractionReviewRoutes: FastifyPluginAsync<
  ExtractionReviewRoutesOptions
> = async (fastify, { service, guards }) => {
  const candidateOnly = [
    guards.authenticate,
    guards.requireActiveAccount,
    guards.requireRole('candidate')
  ];

  fastify.get<{ Querystring: ListExtractionReviewItemsQuery }>(
    '/',
    {
      schema: {
        querystring: listExtractionReviewItemsQuerySchema,
        response: { 200: listExtractionReviewItemsResponseSchema }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.listPending(
        request.auth.userId,
        request.query.documentId
      );
      const response: ApiResponse<ExtractionReviewItem[]> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.patch<{ Params: ExtractionReviewItemParams }>(
    '/:reviewItemId/dismiss',
    {
      schema: {
        params: extractionReviewItemParamsSchema,
        response: { 200: dismissExtractionReviewItemResponseSchema }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.dismiss(
        request.auth.userId,
        request.params.reviewItemId,
        parseIfMatchVersion(request.headers['if-match'])
      );
      const response: ApiResponse<ExtractionReviewItem> = {
        success: true,
        data,
        message: 'Extraction review item dismissed successfully',
        timestamp: new Date().toISOString()
      };

      return reply.header('etag', versionEtag(data.version)).send(response);
    }
  );
};
