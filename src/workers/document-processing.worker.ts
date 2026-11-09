import type { ManagedMessageBroker } from '../infrastructure/messaging/message-broker.js';
import {
  PARSE_DOCUMENT_QUEUE,
  createParseDocumentMessageHandler
} from '../modules/document-processing/index.js';
import type { ParseDocumentHandler } from '../modules/document-processing/index.js';

export interface DocumentProcessingWorkerDependencies {
  broker: Pick<ManagedMessageBroker, 'consume'>;
  handler: Pick<ParseDocumentHandler, 'handle'>;
}

export function startDocumentProcessingWorker({
  broker,
  handler
}: DocumentProcessingWorkerDependencies): Promise<void> {
  const messageHandler = createParseDocumentMessageHandler({ handler });

  return broker.consume(PARSE_DOCUMENT_QUEUE, messageHandler);
}
