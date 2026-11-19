import type { DocumentsService } from '../documents/index.js';
import type {
  CandidateEntityMatcher,
  CandidateExtractionWriter,
  ResolvedExtractionClaimInput
} from '../candidates/index.js';
import type { ClaimRecord } from '../candidates/candidates.repository.js';
import type { UnitOfWork } from '../../infrastructure/database/unit-of-work.js';
import type { FastifyBaseLogger } from 'fastify';
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
  resolvedClaimId: string | null;
  version: number;
  // Saved claims and other pending items that may state the same fact, by the
  // rules that find duplicate claims. Listed only for pending items with a
  // match.
  possibleDuplicates?: { claimIds: string[]; reviewItemIds: string[] };
}

export interface ResolvedExtractionReviewItem {
  reviewItem: ExtractionReviewItem;
  claim: ClaimRecord;
}

export interface ExtractionReviewService {
  list(
    ownerUserId: string,
    documentId?: string,
    status?: ExtractionReviewItemRecord['status']
  ): Promise<ExtractionReviewItem[]>;
  dismiss(
    ownerUserId: string,
    reviewItemId: string,
    expectedVersion?: number
  ): Promise<ExtractionReviewItem>;
  resolve(
    ownerUserId: string,
    reviewItemId: string,
    values: unknown,
    expectedVersion?: number
  ): Promise<ResolvedExtractionReviewItem>;
}

export interface ExtractionReviewServiceDependencies {
  repository: Pick<
    ExtractionReviewRepository,
    | 'listForDocuments'
    | 'findById'
    | 'dismissPending'
    | 'resolvePending'
  >;
  documentsService: Pick<DocumentsService, 'getDocument' | 'listDocuments'>;
  candidateWriter: Pick<CandidateExtractionWriter, 'saveResolvedClaim'>;
  unitOfWork: UnitOfWork;
  normalizer: { normalizeClaim(claim: ClaimRecord): Promise<unknown> };
  // Without it, pending items are listed without possible duplicates.
  entityMatcher?: CandidateEntityMatcher;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

// The values a pending item states, in the shape of claim values, so it can be
// compared with claims. Empty and non-text values are left out.
function statedValues(
  item: ExtractionReviewItemRecord
): { values: Record<string, string | string[]>; current: boolean } {
  const values: Record<string, string | string[]> = {};
  let current = false;
  for (const [fieldName, field] of Object.entries(item.fields)) {
    if (!isRecord(field)) {
      continue;
    }
    if (fieldName === 'current') {
      current ||= field.value === true;
      continue;
    }
    current ||= field.current === true;
    if (typeof field.value === 'string' && field.value.trim()) {
      values[fieldName] = field.value.trim();
    } else if (Array.isArray(field.value)) {
      const list = strings(field.value);
      if (list.length > 0) {
        values[fieldName] = list;
      }
    }
  }
  return { values, current };
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
    resolvedClaimId: record.resolvedClaimId,
    version: record.version
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function resolutionInput(
  item: ExtractionReviewItemRecord,
  values: unknown
): ResolvedExtractionClaimInput {
  const rawValues: Record<string, string> = {};
  const fieldSources: Record<string, string[]> = {};
  let current = false;

  for (const [fieldName, field] of Object.entries(item.fields)) {
    if (!isRecord(field)) {
      continue;
    }
    if (typeof field.raw === 'string') {
      rawValues[fieldName] = field.raw;
    }
    const sources = strings(field.sources);
    if (sources.length > 0) {
      fieldSources[fieldName] = sources;
    }
    current ||= field.current === true;
  }

  return {
    type: item.claimType,
    values,
    documentId: item.documentId,
    invocationId: item.extractionInvocationId,
    rawValues,
    fieldSources,
    current
  };
}

export function createExtractionReviewService({
  repository,
  documentsService,
  candidateWriter,
  unitOfWork,
  normalizer,
  entityMatcher,
  logger
}: ExtractionReviewServiceDependencies): ExtractionReviewService {
  // Finding duplicates only helps the candidate review; the items are still
  // listed when it fails.
  async function withPossibleDuplicates(
    ownerUserId: string,
    items: ExtractionReviewItemRecord[]
  ): Promise<ExtractionReviewItem[]> {
    const reviewItems = items.map(toReviewItem);
    const pending = items.filter((item) => item.status === 'pending');
    if (!entityMatcher || pending.length === 0) {
      return reviewItems;
    }
    try {
      const matches = await entityMatcher.findSameEntities(
        ownerUserId,
        pending.map((item) => ({
          key: item.reviewItemId,
          claimType: item.claimType,
          ...statedValues(item)
        }))
      );
      return reviewItems.map((item) => {
        const match = matches.get(item.reviewItemId);
        return match
          ? {
              ...item,
              possibleDuplicates: { claimIds: match.claimIds, reviewItemIds: match.keys }
            }
          : item;
      });
    } catch (error) {
      logger.warn({ err: error }, 'Possible duplicates of review items could not be found');
      return reviewItems;
    }
  }

  return {
    async list(ownerUserId, documentId, status = 'pending') {
      const documentIds = documentId
        ? [(await documentsService.getDocument(ownerUserId, documentId)).documentId]
        : (await documentsService.listDocuments(ownerUserId)).map(
            (document) => document.documentId
          );

      const items = await repository.listForDocuments(documentIds, status);
      if (items.some((item) => item.status !== status)) {
        throw new Error('Review query returned an item with the wrong status');
      }
      return withPossibleDuplicates(ownerUserId, items);
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
    },
    async resolve(ownerUserId, reviewItemId, values, expectedVersion) {
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

      const resolved = await unitOfWork.run(async (transaction) => {
        const claim = await candidateWriter.saveResolvedClaim(
          ownerUserId,
          resolutionInput(current, values),
          transaction
        );
        const result = await repository.resolvePending(
          reviewItemId,
          claim.claimId,
          expectedVersion,
          transaction
        );

        switch (result.status) {
          case 'saved':
            return { reviewItem: toReviewItem(result.record), claim };
          case 'conflict':
            throw new ExtractionReviewVersionConflictError(
              toReviewItem(result.current)
            );
          case 'not_pending':
            throw new ExtractionReviewItemNotPendingError(
              toReviewItem(result.current)
            );
          case 'missing':
            throw new RecordNotFoundError('Extraction review item', reviewItemId);
        }
      });

      try {
        await normalizer.normalizeClaim(resolved.claim);
      } catch (error) {
        logger.warn(
          { err: error, claimId: resolved.claim.claimId },
          'Claim normalization failed'
        );
      }
      return resolved;
    }
  };
}
