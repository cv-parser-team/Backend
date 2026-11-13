import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { documents } from '../documents/documents.table.js';
import { users } from '../users/users.table.js';
import { createCandidatesRepository } from './candidates.repository.js';
import {
  candidates,
  claims,
  employmentDetails,
  projectDetails,
  skillDetails
} from './candidates.table.js';

const runDatabaseTests =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === 'true';
const describeWithDatabase = runDatabaseTests ? describe : describe.skip;

function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL is required for database integration tests'
    );
  }

  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, '')
  );
  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) {
    throw new Error(
      `Database integration tests require a test-scoped database; received '${databaseName}'`
    );
  }

  return databaseUrl;
}

describeWithDatabase('candidates repository database integration', () => {
  let database: AppDatabase;
  let userId: string;
  let candidateId: string;

  beforeAll(async () => {
    database = new AppDatabase(getTestDatabaseUrl());
    await migrate(database.db, {
      migrationsFolder: resolve('src/infrastructure/database/migrations')
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    userId = randomUUID();
    candidateId = randomUUID();
    await database.db.insert(users).values({
      userId,
      name: 'Batch Test Candidate',
      email: `batch-${userId}@example.com`
    });
    await database.db.insert(candidates).values({
      candidateId,
      userId,
      fullName: 'Batch Test Candidate'
    });
  });

  afterEach(async () => {
    if (userId) {
      await database.db.delete(users).where(eq(users.userId, userId));
    }
  });

  it('persists mixed claim types and returns them in input order', async () => {
    const repository = createCandidatesRepository(database);
    const invocationId = randomUUID();
    const documentId = randomUUID();
    const extraction = {
      invocationId,
      sourceDocumentId: documentId,
      rawValues: {},
      fieldSources: {},
      current: false
    };

    const created = await database.db.transaction((transaction) =>
      repository.createClaims(
        [
          {
            candidateId,
            claimType: 'skill',
            origin: 'extracted',
            status: 'pending',
            values: { name: 'TypeScript' },
            extraction
          },
          {
            candidateId,
            claimType: 'skill',
            origin: 'extracted',
            status: 'pending',
            values: { name: 'PostgreSQL' },
            extraction
          },
          {
            candidateId,
            claimType: 'employment',
            origin: 'extracted',
            status: 'pending',
            values: {
              employer: 'Example Labs',
              jobTitle: 'Backend Engineer',
              startDate: '2022-01',
              skills: ['TypeScript', 'PostgreSQL']
            },
            extraction
          },
          {
            candidateId,
            claimType: 'project',
            origin: 'extracted',
            status: 'pending',
            values: { name: 'LuminaCV', startDate: '2025-01' },
            extraction
          }
        ],
        transaction
      )
    );

    expect(created.map(({ claimType }) => claimType)).toEqual([
      'skill',
      'skill',
      'employment',
      'project'
    ]);
    expect(created.map(({ values }) => values)).toEqual([
      { name: 'TypeScript' },
      { name: 'PostgreSQL' },
      {
        employer: 'Example Labs',
        jobTitle: 'Backend Engineer',
        startDate: '2022-01',
        skills: ['TypeScript', 'PostgreSQL']
      },
      { name: 'LuminaCV', startDate: '2025-01' }
    ]);
    expect(created.every((claim) =>
      claim.extraction?.sourceDocumentId === documentId
    )).toBe(true);

    const claimIds = created.map(({ claimId }) => claimId);
    const [storedSkills, storedEmployment, storedProjects] =
      await Promise.all([
        database.db
          .select()
          .from(skillDetails)
          .where(inArray(skillDetails.claimId, claimIds)),
        database.db
          .select()
          .from(employmentDetails)
          .where(inArray(employmentDetails.claimId, claimIds)),
        database.db
          .select()
          .from(projectDetails)
          .where(inArray(projectDetails.claimId, claimIds))
      ]);

    expect(storedSkills).toHaveLength(2);
    expect(storedEmployment).toHaveLength(1);
    expect(storedProjects).toHaveLength(1);
  });

  it('rolls back replacement when a detail row violates a constraint', async () => {
    const repository = createCandidatesRepository(database);
    const invocationId = randomUUID();
    const documentId = randomUUID();
    const extraction = {
      invocationId,
      sourceDocumentId: documentId,
      rawValues: {},
      fieldSources: {},
      current: false
    };
    const [existing] = await database.db.transaction((transaction) =>
      repository.createClaims(
        [
          {
            candidateId,
            claimType: 'skill',
            origin: 'extracted',
            status: 'pending',
            values: { name: 'Existing skill' },
            extraction
          }
        ],
        transaction
      )
    );

    await expect(
      database.db.transaction(async (transaction) => {
        await repository.deletePendingExtractedClaims(
          candidateId,
          documentId,
          transaction
        );
        await repository.createClaims(
          [
            {
              candidateId,
              claimType: 'skill',
              origin: 'extracted',
              status: 'pending',
              values: { name: 'Replacement skill' },
              extraction
            },
            {
              candidateId,
              claimType: 'employment',
              origin: 'extracted',
              status: 'pending',
              values: {
                employer: 'Example Labs',
                jobTitle: 'Backend Engineer',
                startDate: '2025-12',
                endDate: '2025-01'
              },
              extraction
            }
          ],
          transaction
        );
      })
    ).rejects.toMatchObject({ code: 'DATABASE_ERROR' });

    const storedClaims = await database.db
      .select({ claimId: claims.claimId })
      .from(claims)
      .where(eq(claims.candidateId, candidateId));
    expect(storedClaims).toEqual([{ claimId: existing!.claimId }]);

    const remaining = await repository.listClaims(candidateId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      claimId: existing!.claimId,
      values: { name: 'Existing skill' }
    });
  });

  it('loads ordered physical occurrences only for accepted owned claims and cascades document deletion', async () => {
    const repository = createCandidatesRepository(database);
    const otherUserId = randomUUID();
    const otherCandidateId = randomUUID();
    await database.db.insert(users).values({
      userId: otherUserId,
      name: 'Other Candidate',
      email: `other-${otherUserId}@example.com`
    });

    try {
      await database.db.insert(candidates).values({
        candidateId: otherCandidateId,
        userId: otherUserId,
        fullName: 'Other Candidate'
      });

      const pdfDocumentId = randomUUID();
      const docxDocumentId = randomUUID();
      const otherDocumentId = randomUUID();
      const documentRows: (typeof documents.$inferInsert)[] = [
        {
          documentId: pdfDocumentId,
          ownerUserId: userId,
          purpose: 'source',
          originalFilename: 'candidate.pdf',
          mediaType: 'application/pdf',
          byteSize: 100,
          sha256: '1'.repeat(64),
          storageKey: `integration/${pdfDocumentId}`,
          status: 'ready'
        },
        {
          documentId: docxDocumentId,
          ownerUserId: userId,
          purpose: 'source',
          originalFilename: 'candidate.docx',
          mediaType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byteSize: 100,
          sha256: '2'.repeat(64),
          storageKey: `integration/${docxDocumentId}`,
          status: 'ready'
        },
        {
          documentId: otherDocumentId,
          ownerUserId: otherUserId,
          purpose: 'source',
          originalFilename: 'other.pdf',
          mediaType: 'application/pdf',
          byteSize: 100,
          sha256: '3'.repeat(64),
          storageKey: `integration/${otherDocumentId}`,
          status: 'ready'
        }
      ];
      await database.db.insert(documents).values(documentRows);

      const extraction = (sourceDocumentId: string) => ({
        invocationId: randomUUID(),
        sourceDocumentId,
        rawValues: {},
        fieldSources: { name: ['L1'] },
        current: false
      });
      const created = await database.db.transaction((transaction) =>
        repository.createClaims(
          [
            {
              candidateId,
              claimType: 'skill',
              origin: 'extracted',
              status: 'accepted',
              values: { name: 'PostgreSQL' },
              extraction: extraction(pdfDocumentId)
            },
            {
              candidateId,
              claimType: 'skill',
              origin: 'extracted',
              status: 'accepted',
              values: { name: 'TypeScript' },
              extraction: extraction(docxDocumentId)
            },
            {
              candidateId,
              claimType: 'skill',
              origin: 'extracted',
              status: 'pending',
              values: { name: 'Pending' },
              extraction: extraction(pdfDocumentId)
            },
            {
              candidateId,
              claimType: 'skill',
              origin: 'extracted',
              status: 'rejected',
              values: { name: 'Rejected' },
              extraction: extraction(pdfDocumentId)
            },
            {
              candidateId,
              claimType: 'skill',
              origin: 'manual',
              status: 'accepted',
              values: { name: 'Manual' }
            },
            {
              candidateId: otherCandidateId,
              claimType: 'skill',
              origin: 'extracted',
              status: 'accepted',
              values: { name: 'Other owner' },
              extraction: extraction(otherDocumentId)
            }
          ],
          transaction
        )
      );
      const [pdfClaim, docxClaim, pendingClaim, rejectedClaim, manualClaim, otherClaim] =
        created;
      if (
        !pdfClaim ||
        !docxClaim ||
        !pendingClaim ||
        !rejectedClaim ||
        !manualClaim ||
        !otherClaim
      ) {
        throw new Error('Expected all integration claims to be created');
      }

      await database.db.transaction((transaction) =>
        repository.createClaimSourceOccurrences(
          [
            {
              claimId: pdfClaim.claimId,
              documentId: pdfDocumentId,
              anchorKey: 'pdf:1:09',
              sourceReferences: ['L9'],
              fieldNames: ['name'],
              anchor: {
                kind: 'pdf_line',
                order: 9,
                pageNumber: 1,
                box: { x: 10, y: 90, width: 100, height: 12 },
                text: 'PostgreSQL',
                links: []
              }
            },
            {
              claimId: pdfClaim.claimId,
              documentId: pdfDocumentId,
              anchorKey: 'pdf:1:08',
              sourceReferences: ['L8'],
              fieldNames: ['name'],
              anchor: {
                kind: 'pdf_line',
                order: 8,
                pageNumber: 1,
                box: { x: 10, y: 80, width: 100, height: 12 },
                text: 'Databases',
                links: []
              }
            },
            {
              claimId: docxClaim.claimId,
              documentId: docxDocumentId,
              anchorKey: 'docx:block:4',
              sourceReferences: ['B4'],
              fieldNames: ['name'],
              anchor: {
                kind: 'docx_paragraph',
                blockIndex: 4,
                text: 'TypeScript',
                links: []
              }
            },
            {
              claimId: pendingClaim.claimId,
              documentId: pdfDocumentId,
              anchorKey: 'pdf:1:10',
              sourceReferences: ['L10'],
              fieldNames: ['name'],
              anchor: {
                kind: 'pdf_line',
                order: 10,
                pageNumber: 1,
                box: { x: 10, y: 100, width: 100, height: 12 },
                text: 'Pending',
                links: []
              }
            },
            {
              claimId: rejectedClaim.claimId,
              documentId: pdfDocumentId,
              anchorKey: 'pdf:1:11',
              sourceReferences: ['L11'],
              fieldNames: ['name'],
              anchor: {
                kind: 'pdf_line',
                order: 11,
                pageNumber: 1,
                box: { x: 10, y: 110, width: 100, height: 12 },
                text: 'Rejected',
                links: []
              }
            },
            {
              claimId: otherClaim.claimId,
              documentId: otherDocumentId,
              anchorKey: 'pdf:1:01',
              sourceReferences: ['L1'],
              fieldNames: ['name'],
              anchor: {
                kind: 'pdf_line',
                order: 1,
                pageNumber: 1,
                box: { x: 10, y: 10, width: 100, height: 12 },
                text: 'Other owner',
                links: []
              }
            }
          ],
          transaction
        )
      );

      const requestedClaimIds = created.map(({ claimId }) => claimId);
      const occurrences = await repository.listClaimSourceOccurrences(
        candidateId,
        requestedClaimIds
      );
      const expectedClaimOrder = [pdfClaim.claimId, docxClaim.claimId].sort();

      expect([...new Set(occurrences.map(({ claimId }) => claimId))]).toEqual(
        expectedClaimOrder
      );
      expect(occurrences).toHaveLength(3);
      expect(
        occurrences
          .filter(({ claimId }) => claimId === pdfClaim.claimId)
          .map(({ anchorKey }) => anchorKey)
      ).toEqual(['pdf:1:08', 'pdf:1:09']);
      expect(occurrences.map(({ anchor }) => anchor.kind)).toEqual(
        expectedClaimOrder[0] === pdfClaim.claimId
          ? ['pdf_line', 'pdf_line', 'docx_paragraph']
          : ['docx_paragraph', 'pdf_line', 'pdf_line']
      );

      await database.db
        .delete(documents)
        .where(eq(documents.documentId, pdfDocumentId));

      await expect(
        repository.listClaimSourceOccurrences(candidateId, requestedClaimIds)
      ).resolves.toEqual([
        expect.objectContaining({
          claimId: docxClaim.claimId,
          documentId: docxDocumentId,
          anchorKey: 'docx:block:4'
        })
      ]);
    } finally {
      await database.db.delete(users).where(eq(users.userId, otherUserId));
    }
  });
});
