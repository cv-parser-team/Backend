import { and, desc, eq } from 'drizzle-orm';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { AppDatabase } from '../../infrastructure/database/database.js';
import type { DocumentPurpose } from './documents.formats.js';
import { DocumentStatus, documents } from './documents.table.js';

export type DocumentRecord = typeof documents.$inferSelect;
export type CreateDocumentInput = Omit<
  typeof documents.$inferInsert,
  'documentId' | 'status' | 'failureCode' | 'createdAt' | 'updatedAt'
>;

export interface DocumentFilters {
  purpose?: DocumentPurpose;
  status?: DocumentStatus;
}

export interface UpdateDocumentStatusInput {
  ownerUserId: string;
  documentId: string;
  status: DocumentStatus;
  failureCode: string | null;
}

export interface DocumentsRepository {
  createDocument(input: CreateDocumentInput): Promise<DocumentRecord>;
  listDocuments(
    ownerUserId: string,
    filters?: DocumentFilters
  ): Promise<DocumentRecord[]>;
  findDocument(
    ownerUserId: string,
    documentId: string
  ): Promise<DocumentRecord | null>;
  updateDocumentStatus(
    input: UpdateDocumentStatusInput
  ): Promise<DocumentRecord | null>;
  deleteDocument(ownerUserId: string, documentId: string): Promise<boolean>;
}

export function createDocumentsRepository(
  database: AppDatabase
): DocumentsRepository {
  return {
    async createDocument(input) {
      return withDbErrors('Document', async () => {
        const [createdDocument] = await database.db
          .insert(documents)
          .values(input)
          .returning();

        if (!createdDocument) {
          throw new Error('Document creation did not return a record');
        }

        return createdDocument;
      });
    },

    async listDocuments(ownerUserId, filters = {}) {
      return withDbErrors('Documents', () =>
        database.db
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.ownerUserId, ownerUserId),
              filters.purpose
                ? eq(documents.purpose, filters.purpose)
                : undefined,
              filters.status ? eq(documents.status, filters.status) : undefined
            )
          )
          .orderBy(desc(documents.createdAt), desc(documents.documentId))
      );
    },

    async findDocument(ownerUserId, documentId) {
      return withDbErrors('Document', async () => {
        const [document] = await database.db
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.ownerUserId, ownerUserId),
              eq(documents.documentId, documentId)
            )
          )
          .limit(1);

        return document ?? null;
      });
    },

    async updateDocumentStatus(input) {
      return withDbErrors('Document', async () => {
        const [updatedDocument] = await database.db
          .update(documents)
          .set({
            status: input.status,
            failureCode: input.failureCode
          })
          .where(
            and(
              eq(documents.ownerUserId, input.ownerUserId),
              eq(documents.documentId, input.documentId)
            )
          )
          .returning();

        return updatedDocument ?? null;
      });
    },

    async deleteDocument(ownerUserId, documentId) {
      return withDbErrors('Document', async () => {
        const deletedDocuments = await database.db
          .delete(documents)
          .where(
            and(
              eq(documents.ownerUserId, ownerUserId),
              eq(documents.documentId, documentId)
            )
          )
          .returning({ documentId: documents.documentId });

        return deletedDocuments.length > 0;
      });
    }
  };
}
