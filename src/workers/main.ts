import { createApp } from '../app.js';
import { config } from '../config/config.js';
import { bootstrapDocumentProcessingWorker } from './document-processing.bootstrap.js';

async function main(): Promise<void> {
  const app = await createApp();
  const worker = await bootstrapDocumentProcessingWorker(app, {
    intervalMilliseconds: config.normalization.aiPollIntervalMs,
    batchSize: config.normalization.aiBatchSize
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Stopping document processing worker');

    try {
      await worker.close();
    } catch (error) {
      app.log.error(error, 'Failed to stop document processing worker');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  app.log.info('Document processing worker started');
}

void main().catch((error: unknown) => {
  console.error('Failed to start document processing worker', error);
  process.exitCode = 1;
});
