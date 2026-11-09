import type { MessageHandler } from '../../infrastructure/messaging/message-broker.js';
import type { ParseDocumentHandler } from './parse-document.handler.js';
import { parseParseDocumentJob } from './parse-document.job.js';

export interface ParseDocumentMessageHandlerDependencies {
  handler: Pick<ParseDocumentHandler, 'handle'>;
}

export function createParseDocumentMessageHandler({
  handler
}: ParseDocumentMessageHandlerDependencies): MessageHandler {
  return async (message) => {
    let job;

    try {
      job = parseParseDocumentJob(message);
    } catch {
      return 'reject';
    }

    await handler.handle(job);
    return 'ack';
  };
}
