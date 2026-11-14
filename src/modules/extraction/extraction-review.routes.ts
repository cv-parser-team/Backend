import type { FastifyPluginAsync } from 'fastify';
import type { ApiResponse } from '../../shared/http/api-response.js';
import { parseIfMatchVersion, versionEtag } from '../../shared/http/if-match.js';
import type { AuthGuards } from '../auth/auth.guards.js';
import {
  dismissExtractionReviewItemResponseSchema,
  extractionReviewItemParamsSchema,
  listExtractionReviewItemsQuerySchema,
  listExtractionReviewItemsResponseSchema,
  resolveExtractionReviewItemBodySchema,
  resolveExtractionReviewItemResponseSchema,
  type ExtractionReviewItemParams,
  type ListExtractionReviewItemsQuery,
  type ResolveExtractionReviewItemBody
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
      const data = await service.list(
        request.auth.userId,
        request.query.documentId,
        request.query.status
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

  fastify.post<{
    Params: ExtractionReviewItemParams;
    Body: ResolveExtractionReviewItemBody;
  }>(
    '/:reviewItemId/resolve',
    {
      schema: {
        params: extractionReviewItemParamsSchema,
        body: resolveExtractionReviewItemBodySchema,
        response: { 201: resolveExtractionReviewItemResponseSchema }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.resolve(
        request.auth.userId,
        request.params.reviewItemId,
        request.body.values,
        parseIfMatchVersion(request.headers['if-match'])
      );
      const response: ApiResponse<typeof data> = {
        success: true,
        data,
        message: 'Extraction review item resolved successfully',
        timestamp: new Date().toISOString()
      };

      return reply
        .status(201)
        .header('etag', versionEtag(data.reviewItem.version))
        .send(response);
    }
  );
};
