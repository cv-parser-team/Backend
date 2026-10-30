import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { AuthGuards } from '../auth/auth.guards.js';
import {
  DocumentRecord,
  DocumentsRepository
} from './documents.repository.js';
import { documentsRoutes } from './documents.routes.js';
import {
  createDocumentsService,
  DocumentsService
} from './documents.service.js';

const ownerUserId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

const documentRecord: DocumentRecord = {
  documentId,
  ownerUserId,
  purpose: 'source',
  originalFilename: 'resume.pdf',
  mediaType: 'application/pdf',
  byteSize: 1024,
  sha256: 'a'.repeat(64),
  storageKey: 'documents/example',
  status: 'ready',
  failureCode: null,
  createdAt: timestamp,
  updatedAt: timestamp
};

function createGuards(): AuthGuards {
  return {
    async authenticate(request) {
      request.auth = {
        userId: ownerUserId,
        role: 'candidate',
        accountStatus: 'active',
        tokenVersion: 0
      };
    },
    async requireActiveAccount() {},
    requireRole() {
      return async () => {};
    },
    requireSelfOrRole() {
      return async () => {};
    }
  };
}

function createService(): DocumentsService {
  return {
    listDocuments: vi.fn().mockResolvedValue([documentRecord]),
    getDocument: vi.fn().mockResolvedValue(documentRecord),
    deleteDocument: vi.fn().mockResolvedValue(undefined)
  };
}

function createRepository(
  overrides: Partial<DocumentsRepository> = {}
): DocumentsRepository {
  return {
    createDocument: vi.fn().mockResolvedValue(documentRecord),
    listDocuments: vi.fn().mockResolvedValue([documentRecord]),
    findDocument: vi.fn().mockResolvedValue(documentRecord),
    updateDocumentStatus: vi.fn().mockResolvedValue(documentRecord),
    deleteDocument: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

describe('documents service', () => {
  it('lists only the requested owner documents with the supplied filters', async () => {
    const repository = createRepository();
    const service = createDocumentsService(repository);
    const filters = { purpose: 'source' as const, status: 'ready' as const };

    await expect(service.listDocuments(ownerUserId, filters)).resolves.toEqual([
      documentRecord
    ]);
    expect(repository.listDocuments).toHaveBeenCalledWith(ownerUserId, filters);
  });

  it('throws a typed not-found error when metadata is absent', async () => {
    const repository = createRepository({
      findDocument: vi.fn().mockResolvedValue(null)
    });
    const service = createDocumentsService(repository);

    await expect(
      service.getDocument(ownerUserId, documentId)
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('throws a typed not-found error when no owned document is deleted', async () => {
    const repository = createRepository({
      deleteDocument: vi.fn().mockResolvedValue(false)
    });
    const service = createDocumentsService(repository);

    await expect(
      service.deleteDocument(ownerUserId, documentId)
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe('documents routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function createRoutes(service: DocumentsService) {
    app = Fastify();
    await app.register(documentsRoutes, {
      service,
      guards: createGuards()
    });
  }

  it('lists owned documents with validated filters', async () => {
    const service = createService();
    await createRoutes(service);

    const response = await app!.inject({
      method: 'GET',
      url: '/?purpose=source&status=ready'
    });

    expect(response.statusCode).toBe(200);
    expect(service.listDocuments).toHaveBeenCalledWith(ownerUserId, {
      purpose: 'source',
      status: 'ready'
    });
    expect(response.json()).toMatchObject({
      success: true,
      data: [{ documentId }]
    });
  });

  it('rejects an invalid document ID', async () => {
    const service = createService();
    await createRoutes(service);

    const response = await app!.inject({
      method: 'GET',
      url: '/not-a-uuid'
    });

    expect(response.statusCode).toBe(400);
    expect(service.getDocument).not.toHaveBeenCalled();
  });

  it('returns no content after deleting a document', async () => {
    const service = createService();
    await createRoutes(service);

    const response = await app!.inject({
      method: 'DELETE',
      url: `/${documentId}`
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(service.deleteDocument).toHaveBeenCalledWith(ownerUserId, documentId);
  });
});
