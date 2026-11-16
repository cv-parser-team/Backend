import { createHash, randomUUID } from 'node:crypto';
import { prepareUnknownClaimValues } from '../../modules/candidates/candidates.claim-values.js';
import type {
  ClaimRecord,
  CreateCandidateInput,
  CreateClaimInput
} from '../../modules/candidates/candidates.repository.js';
import {
  DEMO_ACCOUNTS,
  DEMO_PASSWORD,
  type DemoAccount,
  type DemoReviewItem,
  type DemoRole
} from './demo-data.js';
import { assertDemoAllowed, type DemoResetResult } from './demo-reset.js';

export interface DemoUserInput {
  name: string;
  email: string;
  role: DemoRole;
  passwordHash: string;
}

export interface DemoReviewDraft {
  claimType: DemoReviewItem['claimType'];
  fields: DemoReviewItem['fields'];
  issues: DemoReviewItem['issues'];
  sources: string[];
  fingerprint: string;
}

export interface DemoSeedDependencies {
  nodeEnv: string;
  accounts?: DemoAccount[];
  reset(): Promise<DemoResetResult>;
  seedDictionary(): Promise<unknown>;
  hashPassword(password: string): Promise<string>;
  // Creates an active user with its token version, as registration does.
  createUser(input: DemoUserInput): Promise<{ userId: string }>;
  createCandidate(input: CreateCandidateInput): Promise<{ candidateId: string }>;
  createClaim(input: CreateClaimInput): Promise<ClaimRecord>;
  normalizeClaim(claim: ClaimRecord): Promise<unknown>;
  // Stores the CV as an already processed source document.
  createProcessedDocument(ownerUserId: string, filename: string): Promise<{ documentId: string }>;
  createReviewItems(
    documentId: string,
    invocationId: string,
    items: DemoReviewDraft[]
  ): Promise<unknown>;
}

export interface DemoSeedResult {
  removed: DemoResetResult;
  accounts: { email: string; role: DemoRole; claims: number; reviewItems: number }[];
}

// Review items are deduplicated by this fingerprint, as extraction does.
function toReviewDraft(item: DemoReviewItem): DemoReviewDraft {
  const sources = [...new Set(Object.values(item.fields).flatMap((field) => field.sources))];
  return {
    claimType: item.claimType,
    fields: item.fields,
    issues: item.issues,
    sources,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ claimType: item.claimType, fields: item.fields }))
      .digest('hex')
  };
}

// Replaces all demo data with a fresh copy. Running it again gives the same
// data, because the previous demo data is removed first. Claims go through the
// API's value rules and are normalized as the API normalizes them.
export async function seedDemoData(dependencies: DemoSeedDependencies): Promise<DemoSeedResult> {
  assertDemoAllowed(dependencies.nodeEnv);

  const removed = await dependencies.reset();
  await dependencies.seedDictionary();
  const passwordHash = await dependencies.hashPassword(DEMO_PASSWORD);
  const accounts: DemoSeedResult['accounts'] = [];

  for (const account of dependencies.accounts ?? DEMO_ACCOUNTS) {
    const { userId } = await dependencies.createUser({
      name: account.name,
      email: account.email,
      role: account.role,
      passwordHash
    });
    let claimCount = 0;
    let reviewItemCount = 0;

    // Extracted claims and review items name the CV they came from and the
    // AI call that read it, so the document is created first.
    const invocationId = randomUUID();
    const sourceDocumentId = account.document
      ? (
          await dependencies.createProcessedDocument(userId, account.document.filename)
        ).documentId
      : undefined;

    if (account.profile) {
      const { candidateId } = await dependencies.createCandidate({
        userId,
        fullName: account.profile.fullName,
        headline: account.profile.headline ?? null,
        summary: account.profile.summary ?? null,
        phone: account.profile.phone ?? null,
        location: account.profile.location ?? null,
        contactEmail: account.profile.contactEmail ?? null,
        profileLinks: account.profile.profileLinks ?? []
      });

      for (const demo of account.claims ?? []) {
        const base = {
          candidateId,
          claimType: demo.claim.type,
          status: demo.status,
          values: prepareUnknownClaimValues(demo.claim.type, demo.claim.values)
        };
        if (demo.origin === 'extracted' && !sourceDocumentId) {
          throw new Error(`${account.email} has extracted claims but no document`);
        }
        const claim = await dependencies.createClaim(
          demo.origin === 'extracted' && sourceDocumentId
            ? {
                ...base,
                origin: 'extracted',
                extraction: {
                  invocationId,
                  sourceDocumentId,
                  rawValues: {},
                  fieldSources: {},
                  current: false
                }
              }
            : { ...base, origin: 'manual' }
        );
        await dependencies.normalizeClaim(claim);
        claimCount += 1;
      }
    }

    if (account.document && sourceDocumentId && account.document.reviewItems.length > 0) {
      await dependencies.createReviewItems(
        sourceDocumentId,
        invocationId,
        account.document.reviewItems.map(toReviewDraft)
      );
      reviewItemCount = account.document.reviewItems.length;
    }

    accounts.push({
      email: account.email,
      role: account.role,
      claims: claimCount,
      reviewItems: reviewItemCount
    });
  }

  return { removed, accounts };
}
