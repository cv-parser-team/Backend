import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { AppDatabase } from './database.js';

declare module 'fastify' {
  interface FastifyInstance {
    database: AppDatabase;
  }
}

export interface DatabasePluginOptions {
  database?: AppDatabase;
}

const registerDatabase: FastifyPluginAsync<DatabasePluginOptions> = async (
  fastify,
  options
) => {
  const database = options.database ?? new AppDatabase();

  fastify.decorate('database', database);
  fastify.addHook('onClose', async () => {
    await database.close();
  });
};

export const databasePlugin = fastifyPlugin(registerDatabase, {
  name: 'database'
});
