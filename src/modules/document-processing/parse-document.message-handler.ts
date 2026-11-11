import type { MessageHandler } from '../../infrastructure/messaging/message-broker.js';
import type { ParseDocumentHandler } from './parse-document.handler.js';
import { parseParseDocumentJob } from './parse-document.job.js';

export interface ParseDocumentMessageLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ParseDocumentMessageHandlerDependencies {
  handler: Pick<ParseDocumentHandler, 'handle'>;
  log: ParseDocumentMessageLogger;
}

export function createParseDocumentMessageHandler({
  handler,
  log
}: ParseDocumentMessageHandlerDependencies): MessageHandler {
  return async (message) => {
    let job;

    try {
      job = parseParseDocumentJob(message);
    } catch (error) {
      log.warn(
        { err: error },
        'Rejected invalid document processing message'
      );
      return 'reject';
    }

    const context = { jobId: job.jobId, documentId: job.documentId };
    log.info(context, 'Received document processing job');

    let result;

    try {
      result = await handler.handle(job);
    } catch (error) {
      log.warn(
        { ...context, err: error },
        'Document processing job handler failed'
      );
      throw error;
    }

    if (result.outcome === 'stale') {
      log.warn(
        context,
        'Document processing attempt stopped because another attempt claimed the job'
      );
    } else {
      log.info(
        { ...context, outcome: result.outcome },
        'Handled document processing job'
      );
    }

    return result.outcome === 'failed' ? 'reject' : 'ack';
  };
}
