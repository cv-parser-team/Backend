import { createApp } from '../app.js';
import { createFakeMessageBroker } from './fake-message-broker.js';

export function createTestApp() {
  return createApp({ messageBroker: createFakeMessageBroker() });
}
