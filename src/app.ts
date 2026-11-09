
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

import { databasePlugin } from './infrastructure/database/database.plugin.js';
import { AppDatabase } from './infrastructure/database/database.js';
import { errorHandlerPlugin } from './infrastructure/http/error-handler.plugin.js';
import { authModule } from './modules/auth/index.js';
import { candidatesModule } from './modules/candidates/index.js';
import { documentsModule } from './modules/documents/index.js';
import { normalizationModule } from './modules/normalization/index.js';
import { parsingModule } from './modules/parsing/index.js';
import { usersModule } from './modules/users/index.js';

export interface CreateAppOptions {
  database?: AppDatabase;
}

export async function createApp(
  options: CreateAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });

  // CORS configuration
  await app.register(cors, {
    origin: true
  });

  // Swagger / OpenAPI configuration
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'LuminaCV API',
        description: 'API documentation for the LuminaCV backend',
        version: '1.0.0'
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

  // Error handling
  await app.register(errorHandlerPlugin);

  // API modules
  await app.register(authModule);
  await app.register(usersModule);
  await app.register(documentsModule);
  await app.register(normalizationModule);
  await app.register(candidatesModule, {
    prefix: '/api/candidates'
  });
  await app.register(parsingModule);

  return app;
}
