import type { DocumentsService } from '../documents/index.js';
import type {
  ExtractionReviewItemRecord,
  ExtractionReviewRepository
} from './extraction-review.repository.js';
import type { ClaimType } from './extraction.schemas.js';
import type { ExtractionReviewIssue } from './extraction.mapper.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import {
  ExtractionReviewItemNotPendingError,
  ExtractionReviewVersionConflictError
} from './extraction.errors.js';

export interface ExtractionReviewItem {
  reviewItemId: string;
  documentId: string;
  claimType: ClaimType;
  fields: Record<string, unknown>;
  issues: ExtractionReviewIssue[];
  sources: string[];
  status: ExtractionReviewItemRecord['status'];
  version: number;
}

export interface ExtractionReviewService {
  listPending(
    ownerUserId: string,
    documentId?: string
  ): Promise<ExtractionReviewItem[]>;
  dismiss(
    ownerUserId: string,
    reviewItemId: string,
    expectedVersion?: number
  ): Promise<ExtractionReviewItem>;
}

export interface ExtractionReviewServiceDependencies {
  repository: Pick<
    ExtractionReviewRepository,
    'listPendingForDocuments' | 'findById' | 'dismissPending'
  >;
  documentsService: Pick<DocumentsService, 'getDocument' | 'listDocuments'>;
}

function toReviewItem(record: ExtractionReviewItemRecord): ExtractionReviewItem {
  return {
    reviewItemId: record.reviewItemId,
    documentId: record.documentId,
    claimType: record.claimType,
    fields: record.fields,
    issues: record.issues,
    sources: record.sources,
    status: record.status,
    version: record.version
  };
}

export function createExtractionReviewService({
  repository,
  documentsService
}: ExtractionReviewServiceDependencies): ExtractionReviewService {
  return {
    async listPending(ownerUserId, documentId) {
      const documentIds = documentId
        ? [(await documentsService.getDocument(ownerUserId, documentId)).documentId]
        : (await documentsService.listDocuments(ownerUserId)).map(
            (document) => document.documentId
          );

      const items = await repository.listPendingForDocuments(documentIds);
      if (items.some((item) => item.status !== 'pending')) {
        throw new Error('Pending review query returned a terminal item');
      }
      return items.map(toReviewItem);
    },
    async dismiss(ownerUserId, reviewItemId, expectedVersion) {
      const current = await repository.findById(reviewItemId);
      if (!current) {
        throw new RecordNotFoundError('Extraction review item', reviewItemId);
      }

      try {
        await documentsService.getDocument(ownerUserId, current.documentId);
      } catch (error) {
        if (error instanceof RecordNotFoundError) {
          throw new RecordNotFoundError('Extraction review item', reviewItemId);
        }
        throw error;
      }

      if (current.status !== 'pending') {
        throw new ExtractionReviewItemNotPendingError(toReviewItem(current));
      }
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new ExtractionReviewVersionConflictError(toReviewItem(current));
      }

      const result = await repository.dismissPending(reviewItemId, expectedVersion);
      switch (result.status) {
        case 'saved':
          return toReviewItem(result.record);
        case 'conflict':
          throw new ExtractionReviewVersionConflictError(toReviewItem(result.current));
        case 'not_pending':
          throw new ExtractionReviewItemNotPendingError(toReviewItem(result.current));
        case 'missing':
          throw new RecordNotFoundError('Extraction review item', reviewItemId);
      }
    }
  };
}
