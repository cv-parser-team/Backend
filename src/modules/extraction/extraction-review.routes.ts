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

function documentedResponse(description: string) {
  return {
    description,
    type: 'object',
    additionalProperties: true
  } as const;
}

const extractionSecurity = [{ bearerAuth: [] }];
const extractionAccessResponses = {
  401: documentedResponse('Authentication required or token is invalid'),
  403: documentedResponse('Active candidate account required')
};
const ifMatchHeadersSchema = {
  type: 'object',
  properties: {
    'if-match': {
      type: 'string',
      description: 'Optional record version used to prevent concurrent overwrites'
    }
  },
  additionalProperties: true
} as const;

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
        tags: ['Extraction'],
        summary: 'List extraction review items',
        security: extractionSecurity,
        querystring: listExtractionReviewItemsQuerySchema,
        response: {
          200: listExtractionReviewItemsResponseSchema,
          400: documentedResponse('Invalid review-item filters'),
          ...extractionAccessResponses
        }
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
        tags: ['Extraction'],
        summary: 'Dismiss an extraction review item',
        security: extractionSecurity,
        headers: ifMatchHeadersSchema,
        params: extractionReviewItemParamsSchema,
        response: {
          200: dismissExtractionReviewItemResponseSchema,
          400: documentedResponse('Invalid review item ID or If-Match header'),
          ...extractionAccessResponses,
          404: documentedResponse('Extraction review item not found'),
          409: documentedResponse('Review item is not pending or has a version conflict')
        }
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
        tags: ['Extraction'],
        summary: 'Resolve an extraction review item',
        security: extractionSecurity,
        headers: ifMatchHeadersSchema,
        params: extractionReviewItemParamsSchema,
        body: resolveExtractionReviewItemBodySchema,
        response: {
          201: resolveExtractionReviewItemResponseSchema,
          400: documentedResponse('Invalid resolution, review item ID, or If-Match header'),
          ...extractionAccessResponses,
          404: documentedResponse('Extraction review item not found'),
          409: documentedResponse('Review item is not pending or has a version conflict')
        }
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
