import { eq } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { documentExtractions, EXTRACTION_CONTENT_VERSION } from './parsing.table.js';
import { ExtractionResult } from './parsing.types.js';

export type ExtractionRecord = typeof documentExtractions.$inferSelect;

export interface ParsingRepository {
  saveExtraction(documentId: string, result: ExtractionResult): Promise<ExtractionRecord>;
  findByDocumentId(documentId: string): Promise<ExtractionRecord | null>;
}

export function createParsingRepository(database: AppDatabase): ParsingRepository {
  return {
    // A document keeps one extraction; parsing it again replaces the result.
    async saveExtraction(documentId, result) {
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
        const [saved] = await database.db
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
