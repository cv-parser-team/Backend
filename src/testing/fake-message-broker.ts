import type { ManagedMessageBroker } from '../infrastructure/messaging/message-broker.js';

export interface PublishedMessage {
  queue: string;
  message: unknown;
}

export interface FakeMessageBroker extends ManagedMessageBroker {
  publishedMessages: PublishedMessage[];
  closeCallCount: number;
}

export function createFakeMessageBroker(): FakeMessageBroker {
  return {
    publishedMessages: [],
    closeCallCount: 0,

    async publish(queue, message) {
      this.publishedMessages.push({ queue, message });
    },

    async close() {
      this.closeCallCount += 1;
    }
  };
}
