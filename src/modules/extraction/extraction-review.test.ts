import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import type { AuthGuards } from '../auth/auth.guards.js';
import type { DocumentRecord } from '../documents/documents.repository.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type {
  ExtractionReviewItemRecord,
  ExtractionReviewRepository
} from './extraction-review.repository.js';
import { extractionReviewRoutes } from './extraction-review.routes.js';
import {
  createExtractionReviewService,
  type ExtractionReviewItem,
  type ExtractionReviewService
} from './extraction-review.service.js';

const ownerUserId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const otherDocumentId = '33333333-3333-4333-8333-333333333333';
const reviewItemId = '44444444-4444-4444-8444-444444444444';
const timestamp = new Date('2026-01-01T00:00:00.000Z');

function document(documentIdValue: string): DocumentRecord {
  return {
    documentId: documentIdValue,
    ownerUserId,
    purpose: 'source',
    originalFilename: 'resume.pdf',
    mediaType: 'application/pdf',
    byteSize: 100,
    sha256: 'a'.repeat(64),
    storageKey: `documents/${documentIdValue}`,
    status: 'ready',
    failureCode: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function reviewRecord(
  status: ExtractionReviewItemRecord['status'] = 'pending'
): ExtractionReviewItemRecord {
  return {
    reviewItemId,
    documentId,
    extractionInvocationId: '55555555-5555-4555-8555-555555555555',
    claimType: 'employment',
    fields: {
      employer: { value: 'Example Corp', confidence: 0.9, sources: ['L1'] }
    },
    issues: [{ field: 'jobTitle', code: 'missing_job_title', required: true }],
    sources: ['L1'],
    fingerprint: 'fingerprint',
    status,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function dependencies(records: ExtractionReviewItemRecord[] = [reviewRecord()]) {
  const listPendingForDocuments = vi
    .fn<ExtractionReviewRepository['listPendingForDocuments']>()
    .mockResolvedValue(records);
  const getDocument = vi
    .fn<DocumentsService['getDocument']>()
    .mockResolvedValue(document(documentId));
  const listDocuments = vi
    .fn<DocumentsService['listDocuments']>()
    .mockResolvedValue([document(documentId), document(otherDocumentId)]);
  const findById = vi
    .fn<ExtractionReviewRepository['findById']>()
    .mockResolvedValue(records[0] ?? null);
  const dismissed = { ...reviewRecord('dismissed'), version: 2 };
  const dismissPending = vi
    .fn<ExtractionReviewRepository['dismissPending']>()
    .mockResolvedValue({ status: 'saved', record: dismissed });
  const service = createExtractionReviewService({
    repository: { listPendingForDocuments, findById, dismissPending },
    documentsService: { getDocument, listDocuments }
  });

  return {
    service,
    listPendingForDocuments,
    findById,
    dismissPending,
    getDocument,
    listDocuments
  };
}

describe('extraction review service', () => {
  it('checks ownership before listing a filtered document', async () => {
    const { service, getDocument, listDocuments, listPendingForDocuments } =
      dependencies();

    await expect(service.listPending(ownerUserId, documentId)).resolves.toEqual([
      {
        reviewItemId,
        documentId,
        claimType: 'employment',
        fields: reviewRecord().fields,
        issues: reviewRecord().issues,
        sources: ['L1'],
        status: 'pending',
        version: 1
      }
    ]);
    expect(getDocument).toHaveBeenCalledWith(ownerUserId, documentId);
    expect(listDocuments).not.toHaveBeenCalled();
    expect(listPendingForDocuments).toHaveBeenCalledWith([documentId]);
  });

  it('does not query review items when the document is not owned', async () => {
    const { service, getDocument, listPendingForDocuments } = dependencies();
    const missing = new RecordNotFoundError('Document', documentId);
    getDocument.mockRejectedValueOnce(missing);

    await expect(service.listPending(ownerUserId, documentId)).rejects.toBe(missing);
    expect(listPendingForDocuments).not.toHaveBeenCalled();
  });

  it('lists pending items across all documents owned by the candidate', async () => {
    const { service, listDocuments, listPendingForDocuments } = dependencies([]);

    await expect(service.listPending(ownerUserId)).resolves.toEqual([]);
    expect(listDocuments).toHaveBeenCalledWith(ownerUserId);
    expect(listPendingForDocuments).toHaveBeenCalledWith([
      documentId,
      otherDocumentId
    ]);
  });

  it('refuses a terminal item if a repository violates its pending-only contract', async () => {
    const { service } = dependencies([reviewRecord('resolved')]);

    await expect(service.listPending(ownerUserId, documentId)).rejects.toThrow(
      'Pending review query returned a terminal item'
    );
  });

  it('dismisses an owned pending item using the expected version', async () => {
    const { service, getDocument, dismissPending } = dependencies();

    await expect(service.dismiss(ownerUserId, reviewItemId, 1)).resolves.toMatchObject({
      reviewItemId,
      status: 'dismissed',
      version: 2
    });
    expect(getDocument).toHaveBeenCalledWith(ownerUserId, documentId);
    expect(dismissPending).toHaveBeenCalledWith(reviewItemId, 1);
  });
});

function guards(): AuthGuards {
  return {
    async authenticate(request) {
      request.auth = {
        userId: ownerUserId,
        role: 'candidate',
        accountStatus: 'active',
        tokenVersion: 0
      };
    },
    async requireActiveAccount() {},
    requireRole() {
      return async () => {};
    },
    requireSelfOrRole() {
      return async () => {};
    }
  };
}

describe('extraction review routes', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function app(service: ExtractionReviewService) {
    const instance = Fastify();
    apps.push(instance);
    await instance.register(extractionReviewRoutes, {
      prefix: '/api/candidates/me/extraction-review-items',
      service,
      guards: guards()
    });
    return instance;
  }

  function routeService(
    listPending: ExtractionReviewService['listPending'],
    dismiss: ExtractionReviewService['dismiss'] = vi.fn()
  ): ExtractionReviewService {
    return { listPending, dismiss };
  }

  it('returns pending items and forwards the optional document filter', async () => {
    const listPending = vi
      .fn<ExtractionReviewService['listPending']>()
      .mockResolvedValue([
        {
          reviewItemId,
          documentId,
          claimType: 'employment',
          fields: reviewRecord().fields,
          issues: reviewRecord().issues,
          sources: ['L1'],
          status: 'pending',
          version: 1
        }
      ]);
    const instance = await app(routeService(listPending));

    const response = await instance.inject({
      method: 'GET',
      url: `/api/candidates/me/extraction-review-items?documentId=${documentId}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: [
        {
          reviewItemId,
          documentId,
          claimType: 'employment',
          fields: reviewRecord().fields,
          issues: reviewRecord().issues,
          sources: ['L1'],
          status: 'pending',
          version: 1
        }
      ]
    });
    expect(listPending).toHaveBeenCalledWith(ownerUserId, documentId);
  });

  it('returns an empty list when the candidate has no pending review items', async () => {
    const listPending = vi
      .fn<ExtractionReviewService['listPending']>()
      .mockResolvedValue([]);
    const instance = await app(routeService(listPending));

    const response = await instance.inject({
      method: 'GET',
      url: '/api/candidates/me/extraction-review-items'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: [] });
    expect(listPending).toHaveBeenCalledWith(ownerUserId, undefined);
  });

  it('rejects an invalid document filter before calling the service', async () => {
    const listPending = vi.fn<ExtractionReviewService['listPending']>();
    const instance = await app(routeService(listPending));

    const response = await instance.inject({
      method: 'GET',
      url: '/api/candidates/me/extraction-review-items?documentId=not-a-uuid'
    });

    expect(response.statusCode).toBe(400);
    expect(listPending).not.toHaveBeenCalled();
  });

  it('passes If-Match when dismissing and returns the new version', async () => {
    const listPending = vi.fn<ExtractionReviewService['listPending']>();
    const dismissed: ExtractionReviewItem = {
      reviewItemId,
      documentId,
      claimType: 'employment',
      fields: reviewRecord().fields,
      issues: reviewRecord().issues,
      sources: ['L1'],
      status: 'dismissed',
      version: 2
    };
    const dismiss = vi
      .fn<ExtractionReviewService['dismiss']>()
      .mockResolvedValue(dismissed);
    const instance = await app(routeService(listPending, dismiss));

    const response = await instance.inject({
      method: 'PATCH',
      url: `/api/candidates/me/extraction-review-items/${reviewItemId}/dismiss`,
      headers: { 'if-match': '"1"' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json()).toMatchObject({
      success: true,
      data: { reviewItemId, status: 'dismissed', version: 2 }
    });
    expect(dismiss).toHaveBeenCalledWith(ownerUserId, reviewItemId, 1);
  });
});
