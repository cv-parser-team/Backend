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
});
