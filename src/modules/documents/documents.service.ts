import {
  DocumentFilters,
  DocumentRecord,
  DocumentsRepository
} from './documents.repository.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import type { Readable } from 'node:stream';
import type { DocumentPurpose } from './documents.formats.js';
import type { DocumentStorage } from './documents.storage.js';
import type { DocumentValidator } from './documents.validator.js';

export interface UploadDocumentInput {
  ownerUserId: string;
  purpose: DocumentPurpose;
  originalFilename: string;
  stream: Readable;
}

export interface DocumentContent {
  document: DocumentRecord;
  stream: Readable;
}

export interface DocumentsService {
  listDocuments(
    ownerUserId: string,
    filters?: DocumentFilters
  ): Promise<DocumentRecord[]>;
  getDocument(ownerUserId: string, documentId: string): Promise<DocumentRecord>;
  deleteDocument(ownerUserId: string, documentId: string): Promise<void>;
  uploadDocument(input: UploadDocumentInput): Promise<DocumentRecord>;
  openDocument(
    ownerUserId: string,
    documentId: string
  ): Promise<DocumentContent>;
}

export interface DocumentsServiceDependencies {
  repository: DocumentsRepository;
  storage: DocumentStorage;
  validator: DocumentValidator;
}

export function createDocumentsService({
  repository,
  storage,
  validator
}: DocumentsServiceDependencies): DocumentsService {
  return {
    async listDocuments(ownerUserId, filters) {
      return repository.listDocuments(ownerUserId, filters);
    },
    async getDocument(ownerUserId, documentId) {
      const document = await repository.findDocument(ownerUserId, documentId);

      if (!document) {
        throw new RecordNotFoundError('Document', documentId);
      }

      return document;
    },
    async deleteDocument(ownerUserId, documentId) {
      const document = await repository.findDocument(ownerUserId, documentId);

      if (!document) {
        throw new RecordNotFoundError('Document', documentId);
      }

      const deletingDocument = await repository.updateDocumentStatus({
        ownerUserId,
        documentId,
        status: 'deleting',
        failureCode: null
      });

      if (!deletingDocument) {
        throw new RecordNotFoundError('Document', documentId);
      }

      await storage.delete(document.storageKey);

      const deleted = await repository.deleteDocument(ownerUserId, documentId);

      if (!deleted) {
        throw new RecordNotFoundError('Document', documentId);
      }
    },
    async uploadDocument(input) {
      const staged = await storage.stage(input.stream);
      let storageKey: string | undefined;

      try {
        const validationStream = await storage.openStaged(staged.stagingKey);
        const { mediaType } = await validator.validate({
          purpose: input.purpose,
          originalFilename: input.originalFilename,
          byteSize: staged.byteSize,
          stream: validationStream
        });

        storageKey = await storage.commit(staged.stagingKey);

        return await repository.createDocument({
          ownerUserId: input.ownerUserId,
          purpose: input.purpose,
          originalFilename: input.originalFilename,
          mediaType,
          byteSize: staged.byteSize,
          sha256: staged.sha256,
          storageKey
        });
      } catch (error) {
        try {
          if (storageKey === undefined) {
            await storage.discard(staged.stagingKey);
          } else {
            await storage.delete(storageKey);
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Document upload and cleanup both failed'
          );
        }

        throw error;
      }
    },
    async openDocument(ownerUserId, documentId) {
      const document = await repository.findDocument(ownerUserId, documentId);

      if (!document) {
        throw new RecordNotFoundError('Document', documentId);
      }

      const stream = await storage.open(document.storageKey);

      return { document, stream };
    }
  };
}
