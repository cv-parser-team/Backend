import { describe, expect, it, vi } from 'vitest';
import type { ClaimRecord, CreateClaimInput } from '../../modules/candidates/candidates.repository.js';
import type { DemoAccount } from './demo-data.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './demo-data.js';
import { type DemoSeedDependencies, seedDemoData } from './demo-seed.js';

function setup(accounts?: DemoAccount[]) {
  const operations: string[] = [];
  const claims: CreateClaimInput[] = [];
  const dependencies: DemoSeedDependencies = {
    nodeEnv: 'development',
    accounts,
    reset: vi.fn(async () => {
      operations.push('reset');
      return { users: 5, files: 2 };
    }),
    seedDictionary: vi.fn(async () => {
      operations.push('dictionary');
    }),
    hashPassword: vi.fn(async (password: string) => `hash(${password})`),
    createUser: vi.fn(async (input) => {
      operations.push(`user ${input.email}`);
      return { userId: `u-${input.email}` };
    }),
    createCandidate: vi.fn(async (input) => {
      operations.push(`profile ${input.fullName}`);
      return { candidateId: `c-${input.userId}` };
    }),
    createClaim: vi.fn(async (input: CreateClaimInput) => {
      operations.push(`claim ${input.origin}`);
      claims.push(input);
      return { claimId: `claim-${claims.length}` } as ClaimRecord;
    }),
    normalizeClaim: vi.fn(async () => undefined),
    createProcessedDocument: vi.fn(async (ownerUserId: string, filename: string) => {
      operations.push(`document ${filename}`);
      return { documentId: `d-${ownerUserId}` };
    }),
    createReviewItems: vi.fn(async () => {
      operations.push('review items');
    })
  };
  return { dependencies, operations, claims };
}

const candidate: DemoAccount = {
  name: 'Test Candidate',
  email: 'test@demo.luminacv.test',
  role: 'candidate',
  profile: { fullName: 'Test Candidate', headline: 'Developer' },
  claims: [
    {
      origin: 'manual',
      status: 'accepted',
      claim: { type: 'skill', values: { name: ' Go ' } },
      purpose: 'Manual'
    },
    {
      origin: 'extracted',
      status: 'pending',
      claim: { type: 'skill', values: { name: 'SQL' } },
      purpose: 'Extracted'
    }
  ],
  document: {
    filename: 'test-cv.docx',
    reviewItems: [
      {
        claimType: 'employment',
        fields: { employer: { value: 'Zain', confidence: 0.9, sources: ['L1', 'L2'] } },
        issues: [{ field: 'jobTitle', code: 'missing_job_title', required: true }],
        purpose: 'Missing title'
      }
    ]
  }
};

describe('demo seeding', () => {
  it('removes old demo data and loads the dictionary before creating anything', async () => {
    const { dependencies, operations } = setup([candidate]);

    await seedDemoData(dependencies);

    expect(operations.slice(0, 2)).toEqual(['reset', 'dictionary']);
  });

  it('creates the user, the CV, the profile, then the claims and review items', async () => {
    const { dependencies, operations } = setup([candidate]);

    const result = await seedDemoData(dependencies);

    expect(operations.slice(2)).toEqual([
      'user test@demo.luminacv.test',
      'document test-cv.docx',
      'profile Test Candidate',
      'claim manual',
      'claim extracted',
      'review items'
    ]);
    expect(result).toEqual({
      removed: { users: 5, files: 2 },
      accounts: [
        { email: 'test@demo.luminacv.test', role: 'candidate', claims: 2, reviewItems: 1 }
      ]
    });
  });

  it('hashes the documented password once for every account', async () => {
    const { dependencies } = setup([candidate]);

    await seedDemoData(dependencies);

    expect(dependencies.hashPassword).toHaveBeenCalledOnce();
    expect(dependencies.hashPassword).toHaveBeenCalledWith(DEMO_PASSWORD);
    expect(dependencies.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: `hash(${DEMO_PASSWORD})`, role: 'candidate' })
    );
  });

  it('prepares claim values with the API rules and links extracted claims to the CV', async () => {
    const { dependencies, claims } = setup([candidate]);

    await seedDemoData(dependencies);

    expect(claims[0]).toEqual({
      candidateId: 'c-u-test@demo.luminacv.test',
      claimType: 'skill',
      origin: 'manual',
      status: 'accepted',
      values: { name: 'Go' }
    });
    expect(claims[1]).toMatchObject({
      origin: 'extracted',
      status: 'pending',
      extraction: { sourceDocumentId: 'd-u-test@demo.luminacv.test', current: false }
    });
  });

  it('normalizes every claim, as the API does', async () => {
    const { dependencies } = setup([candidate]);

    await seedDemoData(dependencies);

    expect(dependencies.normalizeClaim).toHaveBeenCalledTimes(2);
  });

  it('gives review items the sources of their fields and a fingerprint', async () => {
    const { dependencies } = setup([candidate]);

    await seedDemoData(dependencies);

    const [documentId, invocationId, items] = vi.mocked(dependencies.createReviewItems).mock
      .calls[0]!;
    expect(documentId).toBe('d-u-test@demo.luminacv.test');
    expect(invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(items).toEqual([
      expect.objectContaining({
        claimType: 'employment',
        sources: ['L1', 'L2'],
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    ]);
  });

  it('creates reviewer and admin accounts without profiles', async () => {
    const { dependencies } = setup([
      { name: 'Reviewer', email: 'r@demo.luminacv.test', role: 'reviewer' }
    ]);

    await seedDemoData(dependencies);

    expect(dependencies.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reviewer' })
    );
    expect(dependencies.createCandidate).not.toHaveBeenCalled();
  });

  it('refuses extracted claims without a CV', async () => {
    const { dependencies } = setup([{ ...candidate, document: undefined }]);

    await expect(seedDemoData(dependencies)).rejects.toThrow(
      'test@demo.luminacv.test has extracted claims but no document'
    );
  });

  it('refuses invalid claim values', async () => {
    const { dependencies } = setup([
      {
        ...candidate,
        claims: [
          {
            origin: 'manual',
            status: 'accepted',
            claim: { type: 'skill', values: { name: '' } },
            purpose: 'Invalid'
          }
        ]
      }
    ]);

    await expect(seedDemoData(dependencies)).rejects.toMatchObject({
      code: 'INVALID_CLAIM_VALUES'
    });
  });

  it('refuses to run in production, before removing anything', async () => {
    const { dependencies } = setup([candidate]);

    await expect(
      seedDemoData({ ...dependencies, nodeEnv: 'production' })
    ).rejects.toThrow('Demo data cannot be used in production');
    expect(dependencies.reset).not.toHaveBeenCalled();
  });

  it('seeds the full demo data set', async () => {
    const { dependencies } = setup();

    const result = await seedDemoData(dependencies);

    expect(result.accounts.map((account) => account.email)).toEqual(
      DEMO_ACCOUNTS.map((account) => account.email)
    );
  });
});
