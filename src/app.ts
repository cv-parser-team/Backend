
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

import { databasePlugin } from './infrastructure/database/database.plugin.js';
import { AppDatabase } from './infrastructure/database/database.js';
import { errorHandlerPlugin } from './infrastructure/http/error-handler.plugin.js';
import type { ManagedMessageBroker } from './infrastructure/messaging/message-broker.js';
import { messagingPlugin } from './infrastructure/messaging/messaging.plugin.js';
import { authModule } from './modules/auth/index.js';
import { candidatesModule } from './modules/candidates/index.js';
import { documentProcessingModule } from './modules/document-processing/index.js';
import { documentsModule } from './modules/documents/index.js';
import { extractionReviewModule } from './modules/extraction/index.js';
import { normalizationModule } from './modules/normalization/index.js';
import { parsingModule } from './modules/parsing/index.js';
import { usersModule } from './modules/users/index.js';

export interface CreateAppOptions {
  database?: AppDatabase;
  messageBroker?: ManagedMessageBroker;
}

export async function createApp(
  options: CreateAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });

  // CORS configuration
  await app.register(cors, {
    origin: true,
    credentials: true,
    // Browsers hide response headers from other origins unless exposed; the
    // ETag carries the version that edits send back in If-Match.
    exposedHeaders: ['ETag']
  });

  // Swagger / OpenAPI configuration
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'LuminaCV API',
        description: 'API documentation for the LuminaCV backend',
        version: '1.0.0'
      },
      servers: [
        { url: 'http://localhost:4000', description: 'Local development' }
      ],
      tags: [
        { name: 'Auth', description: 'Registration and access-token lifecycle' },
        { name: 'Users', description: 'User administration and lookup' },
        { name: 'Candidates', description: 'Candidate profiles and claims' },
        { name: 'Documents', description: 'Candidate document management' },
        { name: 'Extraction', description: 'Document extraction review' }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          },
          refreshCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'luminaCV_refresh'
          }
        }
      }
    }
  });

  // Swagger UI
  await app.register(swaggerUI, {
    routePrefix: '/docs'
  });

  // Database
  await app.register(databasePlugin, {
    database: options.database
  });

  // Messaging
  await app.register(messagingPlugin, {
    broker: options.messageBroker
  });

  // Error handling
  await app.register(errorHandlerPlugin);

  // API modules
  await app.register(authModule);
  await app.register(usersModule);
  await app.register(documentsModule);
  await app.register(normalizationModule);
  await app.register(extractionReviewModule);
  await app.register(candidatesModule, {
    prefix: '/api/candidates'
  });
  await app.register(parsingModule);
  await app.register(documentProcessingModule);

  return app;
}
