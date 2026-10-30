import { FastifyPluginAsync } from 'fastify';
import { ApiResponse } from '../../shared/http/api-response.js';
import { AuthGuards } from '../auth/auth.guards.js';
import { DocumentRecord } from './documents.repository.js';
import {
  DocumentParams,
  documentParamsSchema,
  ListDocumentsQuery,
  listDocumentsQuerySchema
} from './documents.schemas.js';
import { DocumentsService } from './documents.service.js';

export interface DocumentsRoutesOptions {
  service: DocumentsService;
  guards: AuthGuards;
}

export const documentsRoutes: FastifyPluginAsync<DocumentsRoutesOptions> = async (
  fastify,
  { service, guards }
) => {
  const candidateOnly = [
    guards.authenticate,
    guards.requireActiveAccount,
    guards.requireRole('candidate')
  ];

  fastify.get<{ Querystring: ListDocumentsQuery }>(
    '/',
    {
      schema: { querystring: listDocumentsQuerySchema },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.listDocuments(
        request.auth.userId,
        request.query
      );
      const response: ApiResponse<DocumentRecord[]> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.get<{ Params: DocumentParams }>(
    '/:documentId',
    {
      schema: { params: documentParamsSchema },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.getDocument(
        request.auth.userId,
        request.params.documentId
      );
      const response: ApiResponse<DocumentRecord> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.delete<{ Params: DocumentParams }>(
    '/:documentId',
    {
      schema: { params: documentParamsSchema },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      await service.deleteDocument(
        request.auth.userId,
        request.params.documentId
      );

      return reply.status(204).send();
    }
  );

};
