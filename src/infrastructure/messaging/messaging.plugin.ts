import type { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { config } from '../../config/config.js';
import type { ManagedMessageBroker } from './message-broker.js';
import { createRabbitMqBroker } from './rabbitmq.js';

declare module 'fastify' {
  interface FastifyInstance {
    messageBroker: ManagedMessageBroker;
  }
}

export interface MessagingPluginOptions {
  broker?: ManagedMessageBroker;
}

const registerMessaging: FastifyPluginAsync<MessagingPluginOptions> = async (
  fastify,
  options
) => {
  const broker =
    options.broker ??
    (await createRabbitMqBroker({ url: config.messaging.rabbitMqUrl }));

  fastify.decorate('messageBroker', broker);
  fastify.addHook('onClose', async () => {
    await broker.close();
  });
};

export const messagingPlugin = fastifyPlugin(registerMessaging, {
  name: 'messaging'
});
