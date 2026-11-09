import type {
  ManagedMessageBroker,
  MessageDisposition,
  MessageHandler
} from '../infrastructure/messaging/message-broker.js';

export interface PublishedMessage {
  queue: string;
  message: unknown;
}

export interface FakeMessageBroker extends ManagedMessageBroker {
  publishedMessages: PublishedMessage[];
  consumers: Map<string, MessageHandler>;
  closeCallCount: number;
  deliver(queue: string, message: unknown): Promise<MessageDisposition>;
}

export function createFakeMessageBroker(): FakeMessageBroker {
  return {
    publishedMessages: [],
    consumers: new Map(),
    closeCallCount: 0,

    async publish(queue, message) {
      this.publishedMessages.push({ queue, message });
    },

    async consume(queue, handler) {
      this.consumers.set(queue, handler);
    },

    async deliver(queue, message) {
      const handler = this.consumers.get(queue);

      if (!handler) {
        throw new Error(`No consumer registered for queue ${queue}`);
      }

      return handler(message);
    },

    async close() {
      this.closeCallCount += 1;
      this.consumers.clear();
    }
  };
}
