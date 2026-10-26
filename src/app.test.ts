import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { FastifyInstance } from 'fastify';

describe('application', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('does not register the removed health route', async () => {
    app = await createApp();
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

  it('POST /api/auth/register validates missing fields via Ajv JSON Schema', async () => {
    app = await createApp();
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
    app = await createApp();
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
    app = await createApp();
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
    app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/not-a-valid-uuid'
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
