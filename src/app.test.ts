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

  it('publishes all public endpoints in OpenAPI', async () => {
    app = await createTestApp();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    const document: unknown = response.json();

    expect(response.statusCode).toBe(200);
    expect(document).toMatchObject({
      openapi: '3.0.3',
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Local development'
        }
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }
      },
      paths: {
        '/api/auth/register': {
          post: {
            tags: ['Auth'],
            summary: 'Register a candidate',
            responses: {
              201: { description: 'Candidate registered successfully' },
              400: { description: 'Invalid registration details' },
              409: { description: 'An account with the email already exists' }
            }
          }
        },
        '/api/auth/sign-in': {
          post: {
            tags: ['Auth'],
            summary: 'Sign in',
            responses: {
              200: { description: 'Signed in successfully' },
              400: { description: 'Invalid sign-in details' },
              401: { description: 'Invalid email or password' },
              403: { description: 'Account is not active' }
            }
          }
        },
        '/api/auth/logout': {
          post: {
            tags: ['Auth'],
            summary: 'Log out',
            security: [{ bearerAuth: [] }],
            responses: {
              204: { description: 'Logged out successfully' },
              401: {
                description: 'Authentication required or token is invalid'
              },
              403: { description: 'Account is not active' }
            }
          }
        },
        '/api/candidates/me': {
          post: {
            tags: ['Candidates'],
            summary: 'Create my candidate profile',
            security: [{ bearerAuth: [] }]
          },
          get: { summary: 'Get my candidate profile' },
          patch: { summary: 'Update my candidate profile' }
        },
        '/api/candidates/me/profile': {
          get: { summary: 'Export my structured profile' }
        },
        '/api/candidates/me/claims': {
          post: { summary: 'Add a manual claim' },
          get: { summary: 'List my claims' }
        },
        '/api/candidates/me/claims/{claimId}': {
          get: { summary: 'Get one of my claims' },
          put: { summary: 'Update one of my claims' },
          delete: { summary: 'Delete one of my claims' }
        },
        '/api/candidates/me/claims/{claimId}/review': {
          patch: {
            summary: 'Review an extracted claim',
            security: [{ bearerAuth: [] }]
          }
        },
        '/api/candidates/me/documents/': {
          post: {
            tags: ['Documents'],
            summary: 'Upload candidate documents',
            security: [{ bearerAuth: [] }]
          },
          get: { summary: 'List my documents' }
        },
        '/api/candidates/me/documents/{documentId}': {
          get: { summary: 'Get document metadata' },
          delete: { summary: 'Delete a document' }
        },
        '/api/candidates/me/documents/{documentId}/content': {
          get: { summary: 'Download document content' }
        },
        '/api/users/': {
          get: {
            tags: ['Users'],
            summary: 'List users',
            security: [{ bearerAuth: [] }]
          }
        },
        '/api/users/{id}': {
          get: { summary: 'Get a user' }
        },
        '/api/candidates/me/extraction-review-items/': {
          get: {
            tags: ['Extraction'],
            summary: 'List extraction review items'
          }
        },
        '/api/candidates/me/extraction-review-items/{reviewItemId}/dismiss': {
          patch: { summary: 'Dismiss an extraction review item' }
        },
        '/api/candidates/me/extraction-review-items/{reviewItemId}/resolve': {
          post: {
            summary: 'Resolve an extraction review item',
            security: [{ bearerAuth: [] }]
          }
        }
      }
    });
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
