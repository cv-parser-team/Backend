import { describe, expect, it, vi } from 'vitest';
import { createRabbitMqBroker } from './rabbitmq.js';
import type { RabbitMqBrokerOptions } from './rabbitmq.js';

const url = 'amqp://guest:guest@localhost:5672';
const queue = 'document-processing.parse-document';
const message = {
  version: 1,
  jobId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222'
};

function createRabbitMqDouble() {
  const operations: string[] = [];
  const channel = {
    assertQueue: vi.fn(async () => {
      operations.push('assert');
      return undefined;
    }),
    sendToQueue: vi.fn(
      (
        _queue: string,
        _content: Buffer,
        _options: {
          contentEncoding: string;
          contentType: string;
          persistent: boolean;
        }
      ) => {
        operations.push('send');
        return true;
      }
    ),
    waitForConfirms: vi.fn(async () => {
      operations.push('confirm');
    }),
    close: vi.fn(async () => {
      operations.push('close-channel');
    })
  };
  const connection = {
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn(async () => {
      operations.push('close-connection');
    })
  };
  const connect: NonNullable<RabbitMqBrokerOptions['connect']> = vi
    .fn()
    .mockResolvedValue(connection);

  return { channel, connect, connection, operations };
}

describe('RabbitMQ message broker', () => {
  it('connects with a confirm channel', async () => {
    const { connect, connection } = createRabbitMqDouble();

    await createRabbitMqBroker({ url, connect });

    expect(connect).toHaveBeenCalledWith(url);
    expect(connection.createConfirmChannel).toHaveBeenCalledOnce();
  });

  it('closes the connection when confirm-channel creation fails', async () => {
    const failure = new Error('channel unavailable');
    const { connect, connection } = createRabbitMqDouble();
    connection.createConfirmChannel.mockRejectedValue(failure);

    await expect(createRabbitMqBroker({ url, connect })).rejects.toBe(failure);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('declares a durable queue before publishing persistent JSON', async () => {
    const { channel, connect, operations } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.publish(queue, message);

    expect(operations).toEqual(['assert', 'send', 'confirm']);
    expect(channel.assertQueue).toHaveBeenCalledWith(queue, { durable: true });
    expect(channel.sendToQueue).toHaveBeenCalledOnce();

    const [sentQueue, content, options] = channel.sendToQueue.mock.calls[0]!;
    expect(sentQueue).toBe(queue);
    expect(content.toString('utf8')).toBe(JSON.stringify(message));
    expect(options).toEqual({
      contentEncoding: 'utf-8',
      contentType: 'application/json',
      persistent: true
    });
  });

  it('does not resolve publication before broker confirmation', async () => {
    let confirm: (() => void) | undefined;
    let published = false;
    const { channel, connect } = createRabbitMqDouble();
    channel.waitForConfirms.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        })
    );
    const broker = await createRabbitMqBroker({ url, connect });

    const publication = broker.publish(queue, message).then(() => {
      published = true;
    });
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));

    expect(published).toBe(false);
    confirm!();
    await publication;
    expect(published).toBe(true);
  });

  it('propagates broker confirmation errors', async () => {
    const failure = new Error('message rejected');
    const { channel, connect } = createRabbitMqDouble();
    channel.waitForConfirms.mockRejectedValue(failure);
    const broker = await createRabbitMqBroker({ url, connect });

    await expect(broker.publish(queue, message)).rejects.toBe(failure);
  });

  it('rejects values that JSON cannot encode', async () => {
    const { channel, connect } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await expect(broker.publish(queue, undefined)).rejects.toThrow(
      'RabbitMQ messages must be JSON serializable'
    );
    expect(channel.assertQueue).not.toHaveBeenCalled();
  });

  it('closes the channel before the connection and only closes once', async () => {
    const { channel, connect, connection, operations } =
      createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await Promise.all([broker.close(), broker.close()]);

    expect(operations).toEqual(['close-channel', 'close-connection']);
    expect(channel.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
