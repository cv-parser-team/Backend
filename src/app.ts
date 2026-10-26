import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { databasePlugin } from './infrastructure/database/database.plugin.js';
import { AppDatabase } from './infrastructure/database/database.js';
import { errorHandlerPlugin } from './infrastructure/http/error-handler.plugin.js';
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

  await app.register(cors, {
    origin: true
  });
  await app.register(databasePlugin, { database: options.database });
  await app.register(errorHandlerPlugin);
  await app.register(usersModule, { prefix: '/api/users' });

  return app;
}
