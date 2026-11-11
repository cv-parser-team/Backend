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
  let consumer:
    | ((message: { content: Buffer } | null) => void)
    | undefined;
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
    prefetch: vi.fn(async () => {
      operations.push('prefetch');
    }),
    consume: vi.fn(
      async (
        _queue: string,
        handler: (message: { content: Buffer } | null) => void,
        _options: { noAck: false }
      ) => {
        operations.push('consume');
        consumer = handler;
        return { consumerTag: 'consumer-1' };
      }
    ),
    ack: vi.fn(() => {
      operations.push('ack');
    }),
    nack: vi.fn(
      (
        _message: { content: Buffer },
        _allUpTo: false,
        requeue: boolean
      ) => {
        operations.push(requeue ? 'retry' : 'reject');
      }
    ),
    cancel: vi.fn(async () => {
      operations.push('cancel');
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

  const deliver = (value: string) => {
    if (!consumer) {
      throw new Error('Consumer has not been registered');
    }

    consumer({ content: Buffer.from(value, 'utf8') });
  };

  return { channel, connect, connection, deliver, operations };
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

  it('declares durable queue topology before publishing persistent JSON', async () => {
    const { channel, connect, operations } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.publish(queue, message);

    expect(operations).toEqual(['assert', 'assert', 'send', 'confirm']);
    expect(channel.assertQueue).toHaveBeenNthCalledWith(
      1,
      `${queue}.dead-letter`,
      { durable: true }
    );
    expect(channel.assertQueue).toHaveBeenNthCalledWith(2, queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': `${queue}.dead-letter`
      }
    });
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

  it('acknowledges JSON messages accepted by the handler', async () => {
    const handler = vi.fn().mockResolvedValue('ack');
    const { channel, connect, deliver } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.consume(queue, handler, { maxInFlight: 1 });
    deliver(JSON.stringify(message));
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledOnce());

    expect(channel.assertQueue).toHaveBeenNthCalledWith(
      1,
      `${queue}.dead-letter`,
      { durable: true }
    );
    expect(channel.assertQueue).toHaveBeenNthCalledWith(2, queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': `${queue}.dead-letter`
      }
    });
    expect(channel.prefetch).toHaveBeenCalledWith(1);
    expect(channel.consume).toHaveBeenCalledWith(
      queue,
      expect.any(Function),
      { noAck: false }
    );
    expect(handler).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it.each([
    ['retry', true],
    ['reject', false]
  ] as const)('negative-acknowledges %s outcomes', async (outcome, requeue) => {
    const handler = vi.fn().mockResolvedValue(outcome);
    const { channel, connect, deliver } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.consume(queue, handler, { maxInFlight: 1 });
    deliver(JSON.stringify(message));
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledOnce());

    expect(channel.nack).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(Buffer) }),
      false,
      requeue
    );
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('requeues messages when the handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('temporarily down'));
    const { channel, connect, deliver } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.consume(queue, handler, { maxInFlight: 1 });
    deliver(JSON.stringify(message));
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledOnce());

    expect(channel.nack).toHaveBeenCalledWith(expect.any(Object), false, true);
  });

  it('rejects malformed JSON without calling the handler', async () => {
    const handler = vi.fn().mockResolvedValue('ack');
    const { channel, connect, deliver } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.consume(queue, handler, { maxInFlight: 1 });
    deliver('{invalid json');
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledOnce());

    expect(handler).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.any(Object), false, false);
  });

  it('cancels active consumers before closing the channel', async () => {
    const { channel, connect, operations } = createRabbitMqDouble();
    const broker = await createRabbitMqBroker({ url, connect });

    await broker.consume(queue, async () => 'ack', { maxInFlight: 1 });
    await broker.close();

    expect(channel.cancel).toHaveBeenCalledWith('consumer-1');
    expect(operations).toEqual([
      'assert',
      'assert',
      'prefetch',
      'consume',
      'cancel',
      'close-channel',
      'close-connection'
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid maxInFlight value %s',
    async (maxInFlight) => {
      const { channel, connect } = createRabbitMqDouble();
      const broker = await createRabbitMqBroker({ url, connect });

      await expect(
        broker.consume(queue, async () => 'ack', { maxInFlight })
      ).rejects.toThrow('RabbitMQ maxInFlight must be a positive integer');
      expect(channel.assertQueue).not.toHaveBeenCalled();
      expect(channel.prefetch).not.toHaveBeenCalled();
      expect(channel.consume).not.toHaveBeenCalled();
    }
  );

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
