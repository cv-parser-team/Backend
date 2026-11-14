import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import type { ExtractionReviewItemDraft } from './extraction.mapper.js';
import {
  extractionReviewItems
} from './extraction-review.table.js';

export type ExtractionReviewItemRecord = typeof extractionReviewItems.$inferSelect;

export interface ExtractionReviewRepository {
  replacePendingForDocument(
    documentId: string,
    extractionInvocationId: string,
    items: ExtractionReviewItemDraft[],
    transaction?: DatabaseExecutor
  ): Promise<ExtractionReviewItemRecord[]>;
}

export function createExtractionReviewRepository(
  database: AppDatabase
): ExtractionReviewRepository {
  return {
    async replacePendingForDocument(
      documentId,
      extractionInvocationId,
      items,
      transaction = database.db
    ) {
      return withDbErrors('Extraction review items', async () => {
        await transaction
          .delete(extractionReviewItems)
          .where(
            and(
              eq(extractionReviewItems.documentId, documentId),
              eq(extractionReviewItems.status, 'pending')
            )
          );

        if (items.length === 0) {
          return [];
        }

        return transaction
          .insert(extractionReviewItems)
          .values(
            items.map((item) => ({
              documentId,
              extractionInvocationId,
              ...item
            }))
          )
          .returning();
      });
    }
  };
}

