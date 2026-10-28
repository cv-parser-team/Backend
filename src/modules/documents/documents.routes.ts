import { FastifyPluginAsync } from 'fastify';
import { AuthGuards } from '../auth/auth.guards.js';
import { DocumentsService } from './documents.service.js';

export interface DocumentsRoutesOptions {
  service: DocumentsService;
  guards: AuthGuards;
}

export const documentsRoutes: FastifyPluginAsync<DocumentsRoutesOptions> = async (
  _fastify,
  _options
) => {};
