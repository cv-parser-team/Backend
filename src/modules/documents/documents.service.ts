import { DocumentsRepository } from './documents.repository.js';

export interface DocumentsService {}

export function createDocumentsService(
  _repository: DocumentsRepository
): DocumentsService {
  return {};
}
