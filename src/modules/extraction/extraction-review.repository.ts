import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import type { ExtractionReviewItemDraft } from './extraction.mapper.js';
import {
  extractionReviewItems
} from './extraction-review.table.js';

export type ExtractionReviewItemRecord = typeof extractionReviewItems.$inferSelect;

export type DismissExtractionReviewItemResult =
  | { status: 'saved'; record: ExtractionReviewItemRecord }
  | { status: 'conflict'; current: ExtractionReviewItemRecord }
  | { status: 'not_pending'; current: ExtractionReviewItemRecord }
  | { status: 'missing' };

export type ResolveExtractionReviewItemResult =
  | { status: 'saved'; record: ExtractionReviewItemRecord }
  | { status: 'conflict'; current: ExtractionReviewItemRecord }
  | { status: 'not_pending'; current: ExtractionReviewItemRecord }
  | { status: 'missing' };

export interface ExtractionReviewRepository {
  listForDocuments(
    documentIds: string[],
    status: ExtractionReviewItemRecord['status']
  ): Promise<ExtractionReviewItemRecord[]>;
  findById(reviewItemId: string): Promise<ExtractionReviewItemRecord | null>;
  dismissPending(
    reviewItemId: string,
    expectedVersion?: number
  ): Promise<DismissExtractionReviewItemResult>;
  resolvePending(
    reviewItemId: string,
    resolvedClaimId: string,
    expectedVersion: number | undefined,
    transaction: DatabaseExecutor
  ): Promise<ResolveExtractionReviewItemResult>;
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
    async listForDocuments(documentIds, status) {
      if (documentIds.length === 0) {
        return [];
      }

      return withDbErrors('Extraction review items', () =>
        database.db
          .select()
          .from(extractionReviewItems)
          .where(
            and(
              inArray(extractionReviewItems.documentId, documentIds),
              eq(extractionReviewItems.status, status)
            )
          )
          .orderBy(
            asc(extractionReviewItems.createdAt),
            asc(extractionReviewItems.reviewItemId)
          )
      );
    },
    async findById(reviewItemId) {
      return withDbErrors('Extraction review item', async () => {
        const [item] = await database.db
          .select()
          .from(extractionReviewItems)
          .where(eq(extractionReviewItems.reviewItemId, reviewItemId))
          .limit(1);

        return item ?? null;
      });
    },
    async dismissPending(reviewItemId, expectedVersion) {
      return withDbErrors('Extraction review item', async () => {
        const [saved] = await database.db
          .update(extractionReviewItems)
          .set({
            status: 'dismissed',
            version: sql`${extractionReviewItems.version} + 1`,
            updatedAt: new Date()
          })
          .where(
            and(
              eq(extractionReviewItems.reviewItemId, reviewItemId),
              eq(extractionReviewItems.status, 'pending'),
              expectedVersion === undefined
                ? undefined
                : eq(extractionReviewItems.version, expectedVersion)
            )
          )
          .returning();

        if (saved) {
          return { status: 'saved', record: saved };
        }

        const [current] = await database.db
          .select()
          .from(extractionReviewItems)
          .where(eq(extractionReviewItems.reviewItemId, reviewItemId))
          .limit(1);
        if (!current) {
          return { status: 'missing' };
        }
        if (current.status !== 'pending') {
          return { status: 'not_pending', current };
        }
        return { status: 'conflict', current };
      });
    },
    async resolvePending(
      reviewItemId,
      resolvedClaimId,
      expectedVersion,
      transaction
    ) {
      return withDbErrors('Extraction review item', async () => {
        const [saved] = await transaction
          .update(extractionReviewItems)
          .set({
            status: 'resolved',
            resolvedClaimId,
            version: sql`${extractionReviewItems.version} + 1`,
            updatedAt: new Date()
          })
          .where(
            and(
              eq(extractionReviewItems.reviewItemId, reviewItemId),
              eq(extractionReviewItems.status, 'pending'),
              expectedVersion === undefined
                ? undefined
                : eq(extractionReviewItems.version, expectedVersion)
            )
          )
          .returning();

        if (saved) {
          return { status: 'saved', record: saved };
        }

        const [current] = await transaction
          .select()
          .from(extractionReviewItems)
          .where(eq(extractionReviewItems.reviewItemId, reviewItemId))
          .limit(1);
        if (!current) {
          return { status: 'missing' };
        }
        if (current.status !== 'pending') {
          return { status: 'not_pending', current };
        }
        return { status: 'conflict', current };
      });
    },
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
