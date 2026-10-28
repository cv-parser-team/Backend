import { AppDatabase } from '../../infrastructure/database/database.js';

export interface DocumentsRepository {}

export function createDocumentsRepository(
  _database: AppDatabase
): DocumentsRepository {
  return {};
}
