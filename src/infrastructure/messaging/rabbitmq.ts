import { connect as connectToRabbitMq } from 'amqplib';
import type {
  ManagedMessageBroker,
  MessageDisposition,
  MessageHandler
} from './message-broker.js';

interface RabbitMqMessage {
  content: Buffer;
}

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
  consume(
    queue: string,
    handler: (message: RabbitMqMessage | null) => void,
    options: { noAck: false }
  ): Promise<{ consumerTag: string }>;
  ack(message: RabbitMqMessage): void;
  nack(message: RabbitMqMessage, allUpTo: false, requeue: boolean): void;
  cancel(consumerTag: string): Promise<unknown>;
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

function settleDelivery(
  channel: RabbitMqConfirmChannel,
  message: RabbitMqMessage,
  disposition: MessageDisposition
): void {
  if (disposition === 'ack') {
    channel.ack(message);
    return;
  }

  channel.nack(message, false, disposition === 'retry');
}

async function handleDelivery(
  channel: RabbitMqConfirmChannel,
  message: RabbitMqMessage,
  handler: MessageHandler
): Promise<void> {
  let parsedMessage: unknown;

  try {
    parsedMessage = JSON.parse(message.content.toString('utf8')) as unknown;
  } catch {
    channel.nack(message, false, false);
    return;
  }

  try {
    const disposition = await handler(parsedMessage);
    settleDelivery(channel, message, disposition);
  } catch {
    channel.nack(message, false, true);
  }
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
  const consumerTags = new Set<string>();
  const inFlightDeliveries = new Set<Promise<void>>();

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

    async consume(queue, handler) {
      await channel.assertQueue(queue, { durable: true });
      const { consumerTag } = await channel.consume(
        queue,
        (message) => {
          if (!message) {
            return;
          }

          const delivery = handleDelivery(channel, message, handler);
          inFlightDeliveries.add(delivery);
          void delivery.then(
            () => inFlightDeliveries.delete(delivery),
            () => inFlightDeliveries.delete(delivery)
          );
        },
        { noAck: false }
      );
      consumerTags.add(consumerTag);
    },

    close() {
      closePromise ??= (async () => {
        try {
          for (const consumerTag of consumerTags) {
            await channel.cancel(consumerTag);
          }

          await Promise.allSettled(inFlightDeliveries);
          await channel.close();
        } finally {
          await connection.close();
        }
      })();

      return closePromise;
    }
  };
}
