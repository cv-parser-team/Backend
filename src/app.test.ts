import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from './testing/create-test-app.js';
import { createFakeMessageBroker } from './testing/fake-message-broker.js';

describe('application', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('does not register the removed health route', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/health'
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' }
    });
  });

  it('lets browsers on other origins read entity tags and send If-Match', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/candidates/me',
      headers: { origin: 'http://localhost:3000' }
    });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/candidates/me/claims/00000000-0000-4000-8000-000000000000',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization, if-match'
      }
    });

    expect(response.headers['access-control-expose-headers']).toBe('ETag');
    expect(preflight.headers['access-control-allow-headers']).toContain('if-match');
  });

  it('POST /api/auth/register validates missing fields via Ajv JSON Schema', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'John Doe'
        // missing email and password
      }
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not expose the former public user-creation endpoint', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: {
        name: 'Example User',
        email: 'user@example.com'
      }
    });

    expect(response.statusCode).toBe(404);
  });

  it('requires authentication to list users', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/users'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' }
    });
  });

  it('GET /api/users/:id validates UUID parameter format via Ajv JSON Schema', async () => {
    app = await createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/not-a-valid-uuid'
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('composes messaging and document processing with managed shutdown', async () => {
    const messageBroker = createFakeMessageBroker();
    app = await createApp({ messageBroker });

    expect(app.messageBroker).toBe(messageBroker);
    expect(typeof app.documentProcessingService.schedule).toBe('function');
    expect(typeof app.processingDocumentsService.openDocumentForProcessing).toBe(
      'function'
    );
    expect(typeof app.parseDocumentHandler.handle).toBe('function');

    await app.close();
    app = undefined;

    expect(messageBroker.closeCallCount).toBe(1);
  });
});
