import type { ManagedMessageBroker } from '../infrastructure/messaging/message-broker.js';
import {
  PARSE_DOCUMENT_QUEUE,
  createParseDocumentMessageHandler
} from '../modules/document-processing/index.js';
import type {
  ParseDocumentHandler,
  ParseDocumentMessageLogger
} from '../modules/document-processing/index.js';

const DOCUMENT_PROCESSING_MAX_IN_FLIGHT = 1;

export interface DocumentProcessingWorkerDependencies {
  broker: Pick<ManagedMessageBroker, 'consume'>;
  handler: Pick<ParseDocumentHandler, 'handle'>;
  log: ParseDocumentMessageLogger;
}

export function startDocumentProcessingWorker({
  broker,
  handler,
  log
}: DocumentProcessingWorkerDependencies): Promise<void> {
  const messageHandler = createParseDocumentMessageHandler({ handler, log });

  return broker.consume(PARSE_DOCUMENT_QUEUE, messageHandler, {
    maxInFlight: DOCUMENT_PROCESSING_MAX_IN_FLIGHT
  });
}
