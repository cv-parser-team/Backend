import multipart from '@fastify/multipart';
import Fastify, { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { AuthGuards } from '../auth/auth.guards.js';
import { UnsupportedDocumentTypeError } from './documents.errors.js';
import {
  DocumentRecord,
  DocumentsRepository
} from './documents.repository.js';
import { documentsRoutes } from './documents.routes.js';
import {
  createDocumentsService,
  DocumentsService
} from './documents.service.js';
import type { DocumentStorage } from './documents.storage.js';
import type { DocumentValidator } from './documents.validator.js';

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
    async requireActiveAccount() { },
    requireRole() {
      return async () => { };
    },
    requireSelfOrRole() {
      return async () => { };
    }
  };
}

function createService(): DocumentsService {
  return {
    cleanupDeletingDocuments: vi.fn().mockResolvedValue({
      deleted: 0,
      failures: []
    }),
    listDocuments: vi.fn().mockResolvedValue([documentRecord]),
    getDocument: vi.fn().mockResolvedValue(documentRecord),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    uploadDocument: vi.fn().mockImplementation(async (input) => {
      await buffer(input.stream);
      return documentRecord;
    }),
    openDocument: vi.fn().mockResolvedValue({
      document: documentRecord,
      stream: Readable.from('stored document')
    })
  };
}

function createRepository(
  overrides: Partial<DocumentsRepository> = {}
): DocumentsRepository {
  return {
    createDocument: vi.fn().mockResolvedValue(documentRecord),
    listDeletingDocuments: vi.fn().mockResolvedValue([]),
    listDocuments: vi.fn().mockResolvedValue([documentRecord]),
    findDocument: vi.fn().mockResolvedValue(documentRecord),
    updateDocumentStatus: vi.fn().mockResolvedValue(documentRecord),
    deleteDocument: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

function createStorage(
  overrides: Partial<DocumentStorage> = {}
): DocumentStorage {
  return {
    stage: vi.fn().mockResolvedValue({
      stagingKey: '11111111-1111-4111-8111-111111111111',
      byteSize: 1024,
      sha256: 'a'.repeat(64)
    }),
    openStaged: vi.fn().mockResolvedValue(Readable.from('staged document')),
    commit: vi
      .fn()
      .mockResolvedValue('33333333-3333-4333-8333-333333333333'),
    discard: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(Readable.from('stored document')),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function createValidator(
  overrides: Partial<DocumentValidator> = {}
): DocumentValidator {
  return {
    validate: vi.fn().mockResolvedValue({ mediaType: 'application/pdf' }),
    ...overrides
  };
}

function createMultipartPayload(parts: readonly Buffer[]) {
  const boundary = 'luminacv-test-boundary';
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    payload: Buffer.concat([
      ...parts,
      Buffer.from(`--${boundary}--\r\n`)
    ])
  };
}

function multipartFile(
  name: string,
  filename: string,
  contents: Buffer
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--luminacv-test-boundary\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      'Content-Type: application/pdf\r\n\r\n'
    ),
    contents,
    Buffer.from('\r\n')
  ]);
}

describe('documents service', () => {
  it('cleans up documents left in deleting status', async () => {
    const deletingDocument: DocumentRecord = {
      ...documentRecord,
      status: 'deleting'
    };
    const repository = createRepository({
      listDeletingDocuments: vi.fn().mockResolvedValue([deletingDocument])
    });
    const storage = createStorage();
    const service = createDocumentsService({
      repository,
      storage,
      validator: createValidator()
    });

    await expect(service.cleanupDeletingDocuments()).resolves.toEqual({
      deleted: 1,
      failures: []
    });
    expect(storage.delete).toHaveBeenCalledWith(deletingDocument.storageKey);
    expect(repository.deleteDocument).toHaveBeenCalledWith(
      deletingDocument.ownerUserId,
      deletingDocument.documentId
    );
  });

  it('continues cleanup when one deleting document fails', async () => {
    const storageError = new Error('storage unavailable');
    const firstDocument: DocumentRecord = {
      ...documentRecord,
      status: 'deleting'
    };
    const secondDocument: DocumentRecord = {
      ...firstDocument,
      documentId: '33333333-3333-4333-8333-333333333333',
      storageKey: 'documents/second'
    };
    const repository = createRepository({
      listDeletingDocuments: vi
        .fn()
        .mockResolvedValue([firstDocument, secondDocument])
    });
    const storage = createStorage({
      delete: vi
        .fn()
        .mockRejectedValueOnce(storageError)
        .mockResolvedValueOnce(undefined)
    });
    const service = createDocumentsService({
      repository,
      storage,
      validator: createValidator()
    });

    await expect(service.cleanupDeletingDocuments()).resolves.toEqual({
      deleted: 1,
      failures: [{ documentId: firstDocument.documentId, error: storageError }]
    });
    expect(repository.deleteDocument).toHaveBeenCalledOnce();
    expect(repository.deleteDocument).toHaveBeenCalledWith(
      secondDocument.ownerUserId,
      secondDocument.documentId
    );
  });

  it('lists only the requested owner documents with the supplied filters', async () => {
    const repository = createRepository();
    const service = createDocumentsService({
      repository,
      storage: createStorage(),
      validator: createValidator()
    });
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
    const service = createDocumentsService({
      repository,
      storage: createStorage(),
      validator: createValidator()
    });

    await expect(
      service.getDocument(ownerUserId, documentId)
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('opens an owned document from its opaque storage key', async () => {
    const contents = Buffer.from('original document bytes');
    const repository = createRepository();
    const storage = createStorage({
      open: vi.fn().mockResolvedValue(Readable.from(contents))
    });
    const service = createDocumentsService({
      repository,
      storage,
      validator: createValidator()
    });

    const result = await service.openDocument(ownerUserId, documentId);

    expect(repository.findDocument).toHaveBeenCalledWith(
      ownerUserId,
      documentId
    );
    expect(storage.open).toHaveBeenCalledWith(documentRecord.storageKey);
    expect(result.document).toEqual(documentRecord);
    await expect(buffer(result.stream)).resolves.toEqual(contents);
  });

  it('deletes the owned storage object and its metadata', async () => {
    const repository = createRepository();
    const storage = createStorage();
    const service = createDocumentsService({
      repository,
      storage,
      validator: createValidator()
    });

    await expect(
      service.deleteDocument(ownerUserId, documentId)
    ).resolves.toBeUndefined();

    expect(repository.updateDocumentStatus).toHaveBeenCalledWith({
      ownerUserId,
      documentId,
      status: 'deleting',
      failureCode: null
    });
    expect(storage.delete).toHaveBeenCalledWith(documentRecord.storageKey);
    expect(repository.deleteDocument).toHaveBeenCalledWith(
      ownerUserId,
      documentId
    );
  });

  it('throws a typed not-found error when owned metadata is absent', async () => {
    const repository = createRepository({
      findDocument: vi.fn().mockResolvedValue(null)
    });
    const storage = createStorage();
    const service = createDocumentsService({
      repository,
      storage,
      validator: createValidator()
    });

    await expect(
      service.deleteDocument(ownerUserId, documentId)
    ).rejects.toBeInstanceOf(RecordNotFoundError);

    expect(repository.updateDocumentStatus).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(repository.deleteDocument).not.toHaveBeenCalled();
  });

  it('keeps deleting metadata when storage deletion fails', async () => {
    const storageError = new Error('storage unavailable');
    const repository = createRepository();
    const storage = createStorage({
      delete: vi.fn().mockRejectedValue(storageError)
    });
    const service = createDocumentsService({
      repository,
      storage,
      validator: createValidator()
    });

    await expect(
      service.deleteDocument(ownerUserId, documentId)
    ).rejects.toBe(storageError);

    expect(repository.updateDocumentStatus).toHaveBeenCalledWith({
      ownerUserId,
      documentId,
      status: 'deleting',
      failureCode: null
    });
    expect(repository.deleteDocument).not.toHaveBeenCalled();
  });

  it('stages, validates, commits, and records an uploaded document', async () => {
    const repository = createRepository();
    const storage = createStorage();
    const validator = createValidator();
    const service = createDocumentsService({ repository, storage, validator });
    const stream = Readable.from('uploaded document');

    await expect(
      service.uploadDocument({
        ownerUserId,
        purpose: 'source',
        originalFilename: 'resume.pdf',
        stream
      })
    ).resolves.toEqual(documentRecord);

    expect(storage.stage).toHaveBeenCalledWith(stream);
    expect(validator.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'source',
        originalFilename: 'resume.pdf',
        byteSize: 1024
      })
    );
    expect(repository.createDocument).toHaveBeenCalledWith({
      ownerUserId,
      purpose: 'source',
      originalFilename: 'resume.pdf',
      mediaType: 'application/pdf',
      byteSize: 1024,
      sha256: 'a'.repeat(64),
      storageKey: '33333333-3333-4333-8333-333333333333'
    });
  });

  it('discards a staged document when validation fails', async () => {
    const validationError = new Error('invalid document');
    const storage = createStorage();
    const service = createDocumentsService({
      repository: createRepository(),
      storage,
      validator: createValidator({
        validate: vi.fn().mockRejectedValue(validationError)
      })
    });

    await expect(
      service.uploadDocument({
        ownerUserId,
        purpose: 'source',
        originalFilename: 'resume.pdf',
        stream: Readable.from('invalid')
      })
    ).rejects.toBe(validationError);

    expect(storage.discard).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(storage.commit).not.toHaveBeenCalled();
  });

  it('deletes a committed file when recording metadata fails', async () => {
    const repositoryError = new Error('database failed');
    const storage = createStorage();
    const service = createDocumentsService({
      repository: createRepository({
        createDocument: vi.fn().mockRejectedValue(repositoryError)
      }),
      storage,
      validator: createValidator()
    });

    await expect(
      service.uploadDocument({
        ownerUserId,
        purpose: 'source',
        originalFilename: 'resume.pdf',
        stream: Readable.from('valid')
      })
    ).rejects.toBe(repositoryError);

    expect(storage.delete).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333'
    );
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
    await app.register(multipart);
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

  it('uploads one document for the authenticated candidate', async () => {
    const service = createService();
    await createRoutes(service);
    const request = createMultipartPayload([
      multipartFile('file', 'resume.pdf', Buffer.from('document bytes'))
    ]);

    const response = await app!.inject({
      method: 'POST',
      url: '/?purpose=source',
      ...request
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(service.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId,
        purpose: 'source',
        originalFilename: 'resume.pdf'
      })
    );
    expect(response.json()).toMatchObject({
      success: true,
      data: [
        {
          success: true,
          filename: 'resume.pdf',
          document: { documentId }
        }
      ]
    });
  });

  it('uploads multiple documents independently', async () => {
    const service = createService();
    await createRoutes(service);
    const request = createMultipartPayload([
      multipartFile('file', 'resume-v1.pdf', Buffer.from('version one')),
      multipartFile('file', 'resume-v2.pdf', Buffer.from('version two'))
    ]);

    const response = await app!.inject({
      method: 'POST',
      url: '/?purpose=source',
      ...request
    });

    expect(response.statusCode).toBe(201);
    expect(service.uploadDocument).toHaveBeenCalledTimes(2);
    expect(response.json()).toMatchObject({
      success: true,
      data: [
        { success: true, filename: 'resume-v1.pdf' },
        { success: true, filename: 'resume-v2.pdf' }
      ]
    });
  });

  it('reports mixed upload results without rolling back valid files', async () => {
    const service = createService();
    service.uploadDocument = vi.fn().mockImplementation(async (input) => {
      await buffer(input.stream);
      if (input.originalFilename === 'invalid.pdf') {
        throw new UnsupportedDocumentTypeError();
      }
      return documentRecord;
    });
    await createRoutes(service);
    const request = createMultipartPayload([
      multipartFile('file', 'valid.pdf', Buffer.from('valid document')),
      multipartFile('file', 'invalid.pdf', Buffer.from('invalid document'))
    ]);

    const response = await app!.inject({
      method: 'POST',
      url: '/?purpose=source',
      ...request
    });

    expect(response.statusCode).toBe(207);
    expect(response.json()).toMatchObject({
      success: true,
      data: [
        { success: true, filename: 'valid.pdf' },
        {
          success: false,
          filename: 'invalid.pdf',
          error: { code: 'UNSUPPORTED_DOCUMENT_TYPE' }
        }
      ]
    });
  });

  it('rejects an upload without a purpose', async () => {
    const service = createService();
    await createRoutes(service);
    const request = createMultipartPayload([
      multipartFile('file', 'resume.pdf', Buffer.from('document bytes'))
    ]);

    const response = await app!.inject({
      method: 'POST',
      url: '/',
      ...request
    });

    expect(response.statusCode).toBe(400);
    expect(service.uploadDocument).not.toHaveBeenCalled();
  });

  it('rejects an upload without a file', async () => {
    const service = createService();
    await createRoutes(service);
    const request = createMultipartPayload([]);

    const response = await app!.inject({
      method: 'POST',
      url: '/?purpose=source',
      ...request
    });

    expect(response.statusCode).toBe(400);
    expect(service.uploadDocument).not.toHaveBeenCalled();
  });

  it('rejects an upload with an invalid purpose', async () => {
    const service = createService();
    await createRoutes(service);
    const request = createMultipartPayload([
      multipartFile('file', 'resume.pdf', Buffer.from('document bytes'))
    ]);

    const response = await app!.inject({
      method: 'POST',
      url: '/?purpose=avatar',
      ...request
    });

    expect(response.statusCode).toBe(400);
    expect(service.uploadDocument).not.toHaveBeenCalled();
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

  it('streams the original document with download headers', async () => {
    const contents = Buffer.from('original document bytes');

    const service = createService();
    service.openDocument = vi.fn().mockResolvedValue({
      document: { ...documentRecord, byteSize: contents.byteLength },
      stream: Readable.from(contents)
    });
    await createRoutes(service);

    const response = await app!.inject({
      method: 'GET',
      url: `/${documentId}/content`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-length']).toBe(
      String(contents.byteLength)
    );
    expect(response.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''resume.pdf"
    );
    expect(response.rawPayload).toEqual(contents);
    expect(service.openDocument).toHaveBeenCalledWith(ownerUserId, documentId);
  });
});
