import { connect as connectToRabbitMq } from 'amqplib';
import type { ManagedMessageBroker } from './message-broker.js';

interface RabbitMqConfirmChannel {
  assertQueue(queue: string, options: { durable: boolean }): Promise<unknown>;
  sendToQueue(
    queue: string,
    content: Buffer,
    options: {
      contentEncoding: string;
      contentType: string;
      persistent: boolean;
    }
  ): boolean;
  waitForConfirms(): Promise<void>;
  close(): Promise<void>;
}

interface RabbitMqConnection {
  createConfirmChannel(): Promise<RabbitMqConfirmChannel>;
  close(): Promise<void>;
}

type ConnectToRabbitMq = (url: string) => Promise<RabbitMqConnection>;

export type RabbitMqBroker = ManagedMessageBroker;

export interface RabbitMqBrokerOptions {
  url: string;
  connect?: ConnectToRabbitMq;
}

function serializeMessage(message: unknown): Buffer {
  const serialized = JSON.stringify(message);

  if (serialized === undefined) {
    throw new TypeError('RabbitMQ messages must be JSON serializable');
  }

  return Buffer.from(serialized, 'utf8');
}

export async function createRabbitMqBroker({
  url,
  connect = connectToRabbitMq
}: RabbitMqBrokerOptions): Promise<RabbitMqBroker> {
  const connection = await connect(url);
  let channel: RabbitMqConfirmChannel;

  try {
    channel = await connection.createConfirmChannel();
  } catch (error) {
    try {
      await connection.close();
    } catch {
      // Preserve the channel creation error that made the broker unusable.
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;

  return {
    async publish(queue, message) {
      const content = serializeMessage(message);

      await channel.assertQueue(queue, { durable: true });
      channel.sendToQueue(queue, content, {
        contentEncoding: 'utf-8',
        contentType: 'application/json',
        persistent: true
      });
      await channel.waitForConfirms();
    },

    close() {
      closePromise ??= (async () => {
        try {
          await channel.close();
        } finally {
          await connection.close();
        }
      })();

      return closePromise;
    }
  };
}
