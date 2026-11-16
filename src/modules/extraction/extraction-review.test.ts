import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import type { AuthGuards } from '../auth/auth.guards.js';
import type { DocumentRecord } from '../documents/documents.repository.js';
import type { DocumentsService } from '../documents/documents.service.js';
import type { CandidateExtractionWriter } from '../candidates/index.js';
import type { ClaimRecord } from '../candidates/candidates.repository.js';
import type { DatabaseExecutor, UnitOfWork } from '../../infrastructure/database/unit-of-work.js';
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
const claimId = '66666666-6666-4666-8666-666666666666';
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
    resolvedClaimId: status === 'resolved' ? claimId : null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function dependencies(records: ExtractionReviewItemRecord[] = [reviewRecord()]) {
  const listForDocuments = vi
    .fn<ExtractionReviewRepository['listForDocuments']>()
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
  const resolved = {
    ...reviewRecord('resolved'),
    resolvedClaimId: claimId,
    version: 2
  };
  const resolvePending = vi
    .fn<ExtractionReviewRepository['resolvePending']>()
    .mockResolvedValue({ status: 'saved', record: resolved });
  const claim: ClaimRecord = {
    claimId,
    supersededByClaimId: null,
    claimType: 'employment',
    origin: 'extracted',
    status: 'accepted',
    current: false,
    candidateEdited: false,
    values: {
      employer: 'Example Corp',
      jobTitle: 'Engineer',
      startDate: '2024'
    },
    extraction: {
      invocationId: reviewRecord().extractionInvocationId,
      sourceDocumentId: documentId,
      rawValues: {},
      fieldSources: { employer: ['L1'] },
      current: false
    },
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const saveResolvedClaim = vi
    .fn<CandidateExtractionWriter['saveResolvedClaim']>()
    .mockResolvedValue(claim);
  const transaction = {} as DatabaseExecutor;
  const unitOfWork: UnitOfWork = {
    run: vi.fn((work) => work(transaction))
  };
  const normalizeClaim = vi.fn().mockResolvedValue(undefined);
  const warn = vi.fn();
  const service = createExtractionReviewService({
    repository: {
      listForDocuments,
      findById,
      dismissPending,
      resolvePending
    },
    documentsService: { getDocument, listDocuments },
    candidateWriter: { saveResolvedClaim },
    unitOfWork,
    normalizer: { normalizeClaim },
    logger: { warn }
  });

  return {
    service,
    listForDocuments,
    findById,
    dismissPending,
    resolvePending,
    saveResolvedClaim,
    transaction,
    unitOfWork,
    normalizeClaim,
    warn,
    getDocument,
    listDocuments
  };
}

describe('extraction review service', () => {
  it('checks ownership before listing a filtered document', async () => {
    const { service, getDocument, listDocuments, listForDocuments } =
      dependencies();

    await expect(service.list(ownerUserId, documentId)).resolves.toEqual([
      {
        reviewItemId,
        documentId,
        claimType: 'employment',
        fields: reviewRecord().fields,
        issues: reviewRecord().issues,
        sources: ['L1'],
        status: 'pending',
        resolvedClaimId: null,
        version: 1
      }
    ]);
    expect(getDocument).toHaveBeenCalledWith(ownerUserId, documentId);
    expect(listDocuments).not.toHaveBeenCalled();
    expect(listForDocuments).toHaveBeenCalledWith([documentId], 'pending');
  });

  it('does not query review items when the document is not owned', async () => {
    const { service, getDocument, listForDocuments } = dependencies();
    const missing = new RecordNotFoundError('Document', documentId);
    getDocument.mockRejectedValueOnce(missing);

    await expect(service.list(ownerUserId, documentId)).rejects.toBe(missing);
    expect(listForDocuments).not.toHaveBeenCalled();
  });

  it('lists pending items across all documents owned by the candidate', async () => {
    const { service, listDocuments, listForDocuments } = dependencies([]);

    await expect(service.list(ownerUserId)).resolves.toEqual([]);
    expect(listDocuments).toHaveBeenCalledWith(ownerUserId);
    expect(listForDocuments).toHaveBeenCalledWith(
      [documentId, otherDocumentId],
      'pending'
    );
  });

  it('lists resolved history through the same ownership check', async () => {
    const { service, getDocument, listForDocuments } = dependencies([
      reviewRecord('resolved')
    ]);

    await expect(
      service.list(ownerUserId, documentId, 'resolved')
    ).resolves.toEqual([
      expect.objectContaining({
        reviewItemId,
        status: 'resolved',
        resolvedClaimId: claimId
      })
    ]);
    expect(getDocument).toHaveBeenCalledWith(ownerUserId, documentId);
    expect(listForDocuments).toHaveBeenCalledWith([documentId], 'resolved');
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

  it('creates an accepted claim and resolves the item in one transaction', async () => {
    const {
      service,
      saveResolvedClaim,
      resolvePending,
      transaction,
      unitOfWork,
      normalizeClaim
    } = dependencies();
    const values = {
      employer: 'Example Corp',
      jobTitle: 'Engineer',
      startDate: '2024'
    };

    await expect(
      service.resolve(ownerUserId, reviewItemId, values, 1)
    ).resolves.toMatchObject({
      reviewItem: { status: 'resolved', resolvedClaimId: claimId, version: 2 },
      claim: { claimId, status: 'accepted' }
    });
    expect(unitOfWork.run).toHaveBeenCalledOnce();
    expect(saveResolvedClaim).toHaveBeenCalledWith(
      ownerUserId,
      expect.objectContaining({
        type: 'employment',
        values,
        documentId,
        fieldSources: { employer: ['L1'] }
      }),
      transaction
    );
    expect(resolvePending).toHaveBeenCalledWith(
      reviewItemId,
      claimId,
      1,
      transaction
    );
    expect(normalizeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ claimId, status: 'accepted' })
    );
  });

  it('rejects a stale resolution before starting a transaction', async () => {
    const { service, saveResolvedClaim, unitOfWork } = dependencies();

    await expect(
      service.resolve(ownerUserId, reviewItemId, { name: 'TypeScript' }, 9)
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(unitOfWork.run).not.toHaveBeenCalled();
    expect(saveResolvedClaim).not.toHaveBeenCalled();
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
    list: ExtractionReviewService['list'],
    dismiss: ExtractionReviewService['dismiss'] = vi.fn(),
    resolve: ExtractionReviewService['resolve'] = vi.fn()
  ): ExtractionReviewService {
    return { list, dismiss, resolve };
  }

  it('returns resolved history and forwards document and status filters', async () => {
    const list = vi
      .fn<ExtractionReviewService['list']>()
      .mockResolvedValue([
        {
          reviewItemId,
          documentId,
          claimType: 'employment',
          fields: reviewRecord().fields,
          issues: reviewRecord().issues,
          sources: ['L1'],
          status: 'resolved',
          resolvedClaimId: claimId,
          version: 1
        }
      ]);
    const instance = await app(routeService(list));

    const response = await instance.inject({
      method: 'GET',
      url: `/api/candidates/me/extraction-review-items?documentId=${documentId}&status=resolved`
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
          status: 'resolved',
          resolvedClaimId: claimId,
          version: 1
        }
      ]
    });
    expect(list).toHaveBeenCalledWith(ownerUserId, documentId, 'resolved');
  });

  it('returns an empty list when the candidate has no pending review items', async () => {
    const list = vi
      .fn<ExtractionReviewService['list']>()
      .mockResolvedValue([]);
    const instance = await app(routeService(list));

    const response = await instance.inject({
      method: 'GET',
      url: '/api/candidates/me/extraction-review-items'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, data: [] });
    expect(list).toHaveBeenCalledWith(ownerUserId, undefined, 'pending');
  });

  it('rejects an invalid document filter before calling the service', async () => {
    const list = vi.fn<ExtractionReviewService['list']>();
    const instance = await app(routeService(list));

    const response = await instance.inject({
      method: 'GET',
      url: '/api/candidates/me/extraction-review-items?documentId=not-a-uuid'
    });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('passes If-Match when dismissing and returns the new version', async () => {
    const list = vi.fn<ExtractionReviewService['list']>();
    const dismissed: ExtractionReviewItem = {
      reviewItemId,
      documentId,
      claimType: 'employment',
      fields: reviewRecord().fields,
      issues: reviewRecord().issues,
      sources: ['L1'],
      status: 'dismissed',
      resolvedClaimId: null,
      version: 2
    };
    const dismiss = vi
      .fn<ExtractionReviewService['dismiss']>()
      .mockResolvedValue(dismissed);
    const instance = await app(routeService(list, dismiss));

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

  it('forwards corrected values and returns the resolved item version', async () => {
    const list = vi.fn<ExtractionReviewService['list']>();
    const dismiss = vi.fn<ExtractionReviewService['dismiss']>();
    const { service } = dependencies();
    const resolve = vi
      .fn<ExtractionReviewService['resolve']>()
      .mockImplementation(service.resolve);
    const instance = await app(routeService(list, dismiss, resolve));

    const response = await instance.inject({
      method: 'POST',
      url: `/api/candidates/me/extraction-review-items/${reviewItemId}/resolve`,
      headers: { 'if-match': '"1"' },
      payload: {
        values: {
          employer: 'Example Corp',
          jobTitle: 'Engineer',
          startDate: '2024'
        }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        reviewItem: { status: 'resolved', resolvedClaimId: claimId },
        claim: { claimId, status: 'accepted' }
      }
    });
    expect(resolve).toHaveBeenCalledWith(
      ownerUserId,
      reviewItemId,
      {
        employer: 'Example Corp',
        jobTitle: 'Engineer',
        startDate: '2024'
      },
      1
    );
  });
});
