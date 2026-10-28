import { createApp } from './app.js';
import { config } from './config/config.js';

async function bootstrap() {
  const app = await createApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`🚀 LuminaCV Fastify Server listening on http://localhost:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

bootstrap();
