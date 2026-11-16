import { eq } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { documentExtractions, EXTRACTION_CONTENT_VERSION } from './parsing.table.js';
import type { UnmappedItem } from './parsing.table.js';
import { ExtractionResult } from './parsing.types.js';

export type ExtractionRecord = typeof documentExtractions.$inferSelect;

export interface ParsingRepository {
  saveExtraction(
    documentId: string,
    result: ExtractionResult,
    transaction?: DatabaseExecutor
  ): Promise<ExtractionRecord>;
  saveUnmappedData(
    documentId: string,
    items: UnmappedItem[],
    transaction?: DatabaseExecutor
  ): Promise<ExtractionRecord>;
  findByDocumentId(documentId: string): Promise<ExtractionRecord | null>;
}

export function createParsingRepository(database: AppDatabase): ParsingRepository {
  return {
    // A document keeps one extraction; parsing it again replaces the result.
    async saveExtraction(documentId, result, transaction = database.db) {
      return withDbErrors('Document extraction', async () => {
        const values = {
          status: result.status,
          format: result.format,
          pageCount: result.pageCount,
          content: {
            version: EXTRACTION_CONTENT_VERSION,
            pages: result.pages,
            blocks: result.blocks
          },
          failures: result.failures,
          parserVersion: result.parserVersion
        };
        const [saved] = await transaction
          .insert(documentExtractions)
          .values({ documentId, ...values })
          .onConflictDoUpdate({
            target: documentExtractions.documentId,
            set: { ...values, updatedAt: new Date() }
          })
          .returning();

        if (!saved) {
          throw new Error('Document extraction save did not return a record');
        }

        return saved;
      });
    },

    // Unmapped data is the latest successful AI-extraction snapshot. Replacing
    // it with an empty list deliberately clears items from an older run.
    async saveUnmappedData(documentId, items, transaction = database.db) {
      return withDbErrors('Document extraction', async () => {
        const [saved] = await transaction
          .update(documentExtractions)
          .set({ unmappedData: items, updatedAt: new Date() })
          .where(eq(documentExtractions.documentId, documentId))
          .returning();

        if (!saved) {
          throw new RecordNotFoundError('Document extraction', documentId);
        }

        return saved;
      });
    },

    async findByDocumentId(documentId) {
      return withDbErrors('Document extraction', async () => {
        const [extraction] = await database.db
          .select()
          .from(documentExtractions)
          .where(eq(documentExtractions.documentId, documentId))
          .limit(1);

        return extraction ?? null;
      });
    }
  };
}
