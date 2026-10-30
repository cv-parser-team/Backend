import {
  DocumentFilters,
  DocumentRecord,
  DocumentsRepository
} from './documents.repository.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';

export interface DocumentsService {
  listDocuments(
    ownerUserId: string,
    filters?: DocumentFilters
  ): Promise<DocumentRecord[]>;
  getDocument(ownerUserId: string, documentId: string): Promise<DocumentRecord>;
  deleteDocument(ownerUserId: string, documentId: string): Promise<void>;
}


export function createDocumentsService(
  repository: DocumentsRepository
): DocumentsService {
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
      const deleted = await repository.deleteDocument(ownerUserId, documentId);

      if (!deleted) {
        throw new RecordNotFoundError('Document', documentId);
      }
    }
  };
}
