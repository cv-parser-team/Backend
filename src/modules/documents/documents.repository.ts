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

export interface FindDocumentByChecksumInput {
  ownerUserId: string;
  purpose: DocumentPurpose;
  sha256: string;
}

export interface MarkDocumentFailedInput {
  documentId: string;
  failureCode: string;
}

export interface DocumentsRepository {
  createDocument(input: CreateDocumentInput): Promise<DocumentRecord | null>;
  listDeletingDocuments(): Promise<DocumentRecord[]>;
  listStorageKeys(): Promise<string[]>;
  listDocuments(
    ownerUserId: string,
    filters?: DocumentFilters
  ): Promise<DocumentRecord[]>;
  findDocument(
    ownerUserId: string,
    documentId: string
  ): Promise<DocumentRecord | null>;
  findDocumentById(documentId: string): Promise<DocumentRecord | null>;
  findDocumentByChecksum(
    input: FindDocumentByChecksumInput
  ): Promise<DocumentRecord | null>;
  markDocumentProcessing(documentId: string): Promise<DocumentRecord | null>;
  markDocumentReady(documentId: string): Promise<DocumentRecord | null>;
  markDocumentFailed(
    input: MarkDocumentFailedInput
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
          .onConflictDoNothing({
            target: [
              documents.ownerUserId,
              documents.purpose,
              documents.sha256
            ]
          })
          .returning();

        return createdDocument ?? null;
      });
    },

    async listDeletingDocuments() {
      return withDbErrors('Documents', () =>
        database.db
          .select()
          .from(documents)
          .where(eq(documents.status, 'deleting'))
          .orderBy(documents.updatedAt, documents.documentId)
      );
    },

    async listStorageKeys() {
      return withDbErrors('Documents', async () => {
        const records = await database.db
          .select({ storageKey: documents.storageKey })
          .from(documents);

        return records.map((record) => record.storageKey);
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

    async findDocumentById(documentId) {
      return withDbErrors('Document', async () => {
        const [document] = await database.db
          .select()
          .from(documents)
          .where(eq(documents.documentId, documentId))
          .limit(1);

        return document ?? null;
      });
    },

    async findDocumentByChecksum(input) {
      return withDbErrors('Document', async () => {
        const [document] = await database.db
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.ownerUserId, input.ownerUserId),
              eq(documents.purpose, input.purpose),
              eq(documents.sha256, input.sha256)
            )
          )
          .limit(1);

        return document ?? null;
      });
    },

    async markDocumentProcessing(documentId) {
      return withDbErrors('Document', async () => {
        const [processingDocument] = await database.db
          .update(documents)
          .set({ status: 'processing', failureCode: null })
          .where(
            and(
              eq(documents.documentId, documentId),
              eq(documents.status, 'stored')
            )
          )
          .returning();

        return processingDocument ?? null;
      });
    },

    async markDocumentReady(documentId) {
      return withDbErrors('Document', async () => {
        const [readyDocument] = await database.db
          .update(documents)
          .set({ status: 'ready', failureCode: null })
          .where(
            and(
              eq(documents.documentId, documentId),
              eq(documents.status, 'processing')
            )
          )
          .returning();

        return readyDocument ?? null;
      });
    },

    async markDocumentFailed({ documentId, failureCode }) {
      return withDbErrors('Document', async () => {
        const [failedDocument] = await database.db
          .update(documents)
          .set({ status: 'failed', failureCode })
          .where(
            and(
              eq(documents.documentId, documentId),
              eq(documents.status, 'processing')
            )
          )
          .returning();

        return failedDocument ?? null;
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
