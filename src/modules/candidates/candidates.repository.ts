import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql, SQL } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { withTransientRetry } from '../../infrastructure/database/transient-retry.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  candidates,
  certificationDetails,
  claimAutoMergeNotices,
  claimPairDecisions,
  type AutoMergeClaimSnapshot,
  type ClaimAutoMergeNoticeRecord,
  type ClaimDatePrecision,
  ClaimExtractionMetadata,
  ClaimFieldValue,
  type ClaimSourceAnchor,
  claimRevisions,
  claims,
  ClaimSnapshot,
  educationDetails,
  employmentDetails,
  languageDetails,
  NewClaimExtractionMetadata,
  projectDetails,
  sourceOccurrences,
  skillDetails
} from './candidates.table.js';

export type CandidateRecord = typeof candidates.$inferSelect;
export type ClaimPairDecisionRecord = typeof claimPairDecisions.$inferSelect;
export type ClaimSourceOccurrenceRecord = typeof sourceOccurrences.$inferSelect;
export type CreateCandidateInput = Omit<
  typeof candidates.$inferInsert,
  'candidateId' | 'createdAt' | 'updatedAt'
>;
export type UpdateCandidateInput = Partial<
  Pick<
    typeof candidates.$inferInsert,
    | 'fullName'
    | 'headline'
    | 'summary'
    | 'phone'
    | 'location'
    | 'contactEmail'
    | 'profileLinks'
  >
>;

type ClaimRow = typeof claims.$inferSelect;
export type ClaimValues = ClaimSnapshot;

export interface CreateClaimSourceOccurrenceInput {
  claimId: string;
  documentId: string;
  anchorKey: string;
  sourceReferences: string[];
  fieldNames: string[];
  anchor: ClaimSourceAnchor;
}

export interface TransferClaimSourceOccurrencesResult {
  moved: number;
  skipped: number;
}

export interface CoalescePendingClaimsInput {
  candidateId: string;
  survivor: { claimId: string; expectedVersion: number };
  duplicate: { claimId: string; expectedVersion: number };
  values: ClaimValues;
  current?: boolean;
  // Short, human-readable messages describing what the merge changed. Emitted
  // as a claim_auto_merge_notices row on the survivor.
  messages: string[];
}

export type CoalescePendingClaimsResult =
  | { status: 'saved'; survivor: ClaimRecord; duplicate: ClaimRecord }
  | { status: 'conflict' | 'not_eligible'; current: ClaimRecord[] }
  | { status: 'missing' };

// One automatic merge event on the surviving claim. Used by both the pending
// + pending coalesce path and the accepted / auto_accepted + pending safe
// enrichment path.
export interface AutoAcceptMergeClaimsInput {
  candidateId: string;
  survivor: { claimId: string; expectedVersion: number };
  duplicate: { claimId: string; expectedVersion: number };
  values: ClaimValues;
  current?: boolean;
  messages: string[];
}

export type AutoAcceptMergeClaimsResult =
  | {
      status: 'saved';
      survivor: ClaimRecord;
      duplicate: ClaimRecord;
      notice: ClaimAutoMergeNoticeRecord;
    }
  | { status: 'conflict' | 'not_eligible'; current: ClaimRecord[] }
  | { status: 'missing' };

export type KeepAutoMergedClaimsSeparateResult =
  | { status: 'saved'; claims: ClaimRecord[] }
  | { status: 'conflict' | 'not_eligible'; current: ClaimRecord[] }
  | { status: 'missing' };

export interface MergeConfirmedClaimsInput {
  candidateId: string;
  survivor: { claimId: string; expectedVersion: number };
  duplicate: { claimId: string; expectedVersion: number };
  values: ClaimValues;
  current?: boolean;
}

export type MergeConfirmedClaimsResult =
  | { status: 'saved'; survivor: ClaimRecord; duplicate: ClaimRecord }
  | { status: 'conflict' | 'not_eligible'; current: ClaimRecord[] }
  | { status: 'missing' };

export interface MergeConfirmedClaimGroupInput {
  candidateId: string;
  claims: Array<{ claimId: string; expectedVersion: number }>;
  survivorClaimId: string;
  values: ClaimValues;
  current?: boolean;
}

export type MergeConfirmedClaimGroupResult =
  | { status: 'saved'; survivor: ClaimRecord; duplicates: ClaimRecord[] }
  | { status: 'conflict' | 'not_eligible'; current: ClaimRecord[] }
  | { status: 'missing' };

export interface RecordClaimsDifferentInput {
  candidateId: string;
  left: { claimId: string; expectedVersion: number };
  right: { claimId: string; expectedVersion: number };
}

export type RecordClaimsDifferentResult =
  | { status: 'saved' }
  | { status: 'conflict' | 'not_eligible'; current: ClaimRecord[] }
  | { status: 'missing' };

export interface ClaimRecord {
  claimId: string;
  supersededByClaimId: string | null;
  claimType: ClaimRow['claimType'];
  origin: ClaimRow['origin'];
  status: ClaimRow['status'];
  current: boolean;
  candidateEdited: boolean;
  values: ClaimValues;
  extraction: ClaimExtractionMetadata | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface CreateClaimBase {
  candidateId: string;
  claimType: ClaimRow['claimType'];
  status: ClaimRow['status'];
  values: ClaimValues;
}

export type CreateClaimInput =
  | (CreateClaimBase & { origin: 'manual'; extraction?: never })
  | (CreateClaimBase & {
    origin: 'extracted';
    extraction: NewClaimExtractionMetadata;
  });

export interface ClaimFilters {
  claimType?: ClaimRow['claimType'];
  status?: ClaimRow['status'] | ClaimRow['status'][];
}

export interface UpdateClaimValuesInput {
  candidateId: string;
  claimId: string;
  values: ClaimValues;
  // The version the caller last read. When given, the write only happens if
  // the record still has it.
  expectedVersion?: number;
}

// The result of a write guarded by `expectedVersion`. `conflict` carries the
// current record, so the caller can show what changed since it was read.
export type VersionedWrite<T> =
  | { status: 'saved'; record: T }
  | { status: 'conflict'; current: T }
  | { status: 'missing' };

export type VersionedDelete<T> =
  | { status: 'deleted' }
  | { status: 'conflict'; current: T }
  | { status: 'missing' };

export type ClaimReviewStatus = Extract<
  ClaimRow['status'],
  'accepted' | 'rejected'
>;

export type ReviewClaimResult =
  | { status: 'saved'; record: ClaimRecord }
  | { status: 'conflict'; current: ClaimRecord }
  | { status: 'not_reviewable'; current: ClaimRecord }
  | { status: 'missing' };

export interface CandidatesRepository {
  findCandidateByUserId(
    userId: string,
    transaction?: DatabaseExecutor
  ): Promise<CandidateRecord | null>;
  createCandidate(input: CreateCandidateInput): Promise<CandidateRecord>;
  updateCandidate(
    candidateId: string,
    input: UpdateCandidateInput,
    expectedVersion?: number
  ): Promise<VersionedWrite<CandidateRecord>>;
  createClaim(
    input: CreateClaimInput,
    transaction?: DatabaseExecutor
  ): Promise<ClaimRecord>;
  createClaims(
    inputs: CreateClaimInput[],
    transaction: DatabaseExecutor
  ): Promise<ClaimRecord[]>;
  createClaimSourceOccurrences(
    inputs: CreateClaimSourceOccurrenceInput[],
    transaction: DatabaseExecutor
  ): Promise<number>;
  transferClaimSourceOccurrences(
    duplicateClaimId: string,
    survivorClaimId: string,
    transaction: DatabaseExecutor
  ): Promise<TransferClaimSourceOccurrencesResult>;
  coalescePendingClaims(
    input: CoalescePendingClaimsInput
  ): Promise<CoalescePendingClaimsResult>;
  autoAcceptMergeClaims(
    input: AutoAcceptMergeClaimsInput
  ): Promise<AutoAcceptMergeClaimsResult>;
  acknowledgeAutoMergeNotices(
    candidateId: string,
    survivorClaimId: string
  ): Promise<number>;
  keepAutoMergedClaimsSeparate(
    candidateId: string,
    survivorClaimId: string,
    expectedVersion?: number
  ): Promise<KeepAutoMergedClaimsSeparateResult>;
  countOpenAutoMergeNotices(candidateId: string, survivorClaimId: string): Promise<number>;
  listOpenAutoMergeNotices(
    candidateId: string,
    survivorClaimIds?: string[]
  ): Promise<ClaimAutoMergeNoticeRecord[]>;
  mergeConfirmedClaims(
    input: MergeConfirmedClaimsInput
  ): Promise<MergeConfirmedClaimsResult>;
  mergeConfirmedClaimGroup(
    input: MergeConfirmedClaimGroupInput
  ): Promise<MergeConfirmedClaimGroupResult>;
  recordClaimsDifferent(
    input: RecordClaimsDifferentInput
  ): Promise<RecordClaimsDifferentResult>;
  listClaimPairDecisions(candidateId: string): Promise<ClaimPairDecisionRecord[]>;
  deletePendingExtractedClaims(
    candidateId: string,
    documentId: string,
    transaction: DatabaseExecutor
  ): Promise<number>;
  listReviewedExtractedClaims(
    candidateId: string,
    documentId: string,
    transaction: DatabaseExecutor
  ): Promise<ClaimRecord[]>;
  reviewExtractedClaim(
    candidateId: string,
    claimId: string,
    status: ClaimReviewStatus,
    expectedVersion?: number
  ): Promise<ReviewClaimResult>;
  listClaims(
    candidateId: string,
    filters?: ClaimFilters,
    transaction?: DatabaseExecutor
  ): Promise<ClaimRecord[]>;
  listClaimSourceOccurrences(
    candidateId: string,
    claimIds: string[]
  ): Promise<ClaimSourceOccurrenceRecord[]>;
  findClaim(candidateId: string, claimId: string): Promise<ClaimRecord | null>;
  updateClaimValues(input: UpdateClaimValuesInput): Promise<VersionedWrite<ClaimRecord>>;
  setClaimStatus(
    candidateId: string,
    claimId: string,
    status: ClaimRecord['status'],
    expectedVersion: number
  ): Promise<ClaimRecord | null>;
  deleteClaim(
    candidateId: string,
    claimId: string,
    expectedVersion?: number
  ): Promise<VersionedDelete<ClaimRecord>>;
}

type QueryExecutor = Pick<AppDatabase['db'], 'select' | 'insert' | 'update'>;

function readText(values: ClaimValues, fieldName: string): string | null {
  const value = values[fieldName];
  return typeof value === 'string' ? value : null;
}

function readRequiredText(values: ClaimValues, fieldName: string): string {
  const value = readText(values, fieldName);
  if (value === null) {
    throw new Error(`Claim field '${fieldName}' is required`);
  }
  return value;
}

function readList(values: ClaimValues, fieldName: string): string[] {
  const value = values[fieldName];
  return Array.isArray(value) ? value : [];
}

function haveSameClaimValues(left: ClaimValues, right: ClaimValues): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey)
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey)
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

interface StoredClaimDate {
  date: string;
  precision: ClaimDatePrecision;
}

function toStoredDate(
  value: string,
  boundary: 'start' | 'end'
): StoredClaimDate {
  if (value.length === 4) {
    return {
      date: `${value}-${boundary === 'start' ? '01' : '12'}-01`,
      precision: 'year'
    };
  }
  return { date: `${value}-01`, precision: 'month' };
}

function fromStoredDate(
  date: string | null,
  precision: ClaimDatePrecision | null
): string | null {
  if (date === null || precision === null) {
    return null;
  }
  return precision === 'year' ? date.slice(0, 4) : date.slice(0, 7);
}

// Optional fields that are empty are omitted, matching the request shape.
function compactValues(
  fields: Record<string, ClaimFieldValue | null>
): ClaimValues {
  const values: ClaimValues = {};
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value !== null && !(Array.isArray(value) && value.length === 0)) {
      values[fieldName] = value;
    }
  }
  return values;
}

function toSkillRow(values: ClaimValues) {
  return { name: readRequiredText(values, 'name') };
}

function toEmploymentRow(values: ClaimValues) {
  const startDate = toStoredDate(readRequiredText(values, 'startDate'), 'start');
  const endValue = readText(values, 'endDate');
  const endDate = endValue === null ? null : toStoredDate(endValue, 'end');
  return {
    employer: readRequiredText(values, 'employer'),
    jobTitle: readRequiredText(values, 'jobTitle'),
    startDate: startDate.date,
    startDatePrecision: startDate.precision,
    endDate: endDate?.date ?? null,
    endDatePrecision: endDate?.precision ?? null,
    location: readText(values, 'location'),
    description: readText(values, 'description'),
    skills: readList(values, 'skills')
  };
}

function toEducationRow(values: ClaimValues) {
  const startDate = toStoredDate(readRequiredText(values, 'startDate'), 'start');
  const endValue = readText(values, 'endDate');
  const endDate = endValue === null ? null : toStoredDate(endValue, 'end');
  return {
    institution: readRequiredText(values, 'institution'),
    degree: readRequiredText(values, 'degree'),
    fieldOfStudy: readText(values, 'fieldOfStudy'),
    startDate: startDate.date,
    startDatePrecision: startDate.precision,
    endDate: endDate?.date ?? null,
    endDatePrecision: endDate?.precision ?? null
  };
}

function toCertificationRow(values: ClaimValues) {
  const issueDate = toStoredDate(readRequiredText(values, 'issueDate'), 'start');
  const expiryValue = readText(values, 'expiryDate');
  const expiryDate = expiryValue === null
    ? null
    : toStoredDate(expiryValue, 'end');
  return {
    title: readRequiredText(values, 'title'),
    issuer: readRequiredText(values, 'issuer'),
    issueDate: issueDate.date,
    issueDatePrecision: issueDate.precision,
    expiryDate: expiryDate?.date ?? null,
    expiryDatePrecision: expiryDate?.precision ?? null,
    credentialId: readText(values, 'credentialId')
  };
}

function toLanguageRow(values: ClaimValues) {
  return {
    name: readRequiredText(values, 'name'),
    proficiency: readText(values, 'proficiency')
  };
}

function toProjectRow(values: ClaimValues) {
  const startValue = readText(values, 'startDate');
  const endValue = readText(values, 'endDate');
  const startDate = startValue === null ? null : toStoredDate(startValue, 'start');
  const endDate = endValue === null ? null : toStoredDate(endValue, 'end');
  return {
    name: readRequiredText(values, 'name'),
    description: readText(values, 'description'),
    role: readText(values, 'role'),
    url: readText(values, 'url'),
    startDate: startDate?.date ?? null,
    startDatePrecision: startDate?.precision ?? null,
    endDate: endDate?.date ?? null,
    endDatePrecision: endDate?.precision ?? null,
    skills: readList(values, 'skills')
  };
}

async function insertDetails(
  executor: QueryExecutor,
  claimId: string,
  claimType: ClaimRow['claimType'],
  values: ClaimValues
): Promise<void> {
  switch (claimType) {
    case 'skill':
      await executor.insert(skillDetails).values({ claimId, ...toSkillRow(values) });
      break;
    case 'employment':
      await executor
        .insert(employmentDetails)
        .values({ claimId, ...toEmploymentRow(values) });
      break;
    case 'education':
      await executor
        .insert(educationDetails)
        .values({ claimId, ...toEducationRow(values) });
      break;
    case 'certification':
      await executor
        .insert(certificationDetails)
        .values({ claimId, ...toCertificationRow(values) });
      break;
    case 'language':
      await executor
        .insert(languageDetails)
        .values({ claimId, ...toLanguageRow(values) });
      break;
    case 'project':
      await executor
        .insert(projectDetails)
        .values({ claimId, ...toProjectRow(values) });
      break;
  }
}

interface ClaimWithId {
  claimId: string;
  input: CreateClaimInput;
}

function toClaimInsert({ claimId, input }: ClaimWithId): typeof claims.$inferInsert {
  return {
    claimId,
    candidateId: input.candidateId,
    claimType: input.claimType,
    origin: input.origin,
    status: input.status,
    current: input.origin === 'extracted' ? input.extraction.current : false,
    extractionInvocationId:
      input.origin === 'extracted' ? input.extraction.invocationId : null,
    extractionDocumentId:
      input.origin === 'extracted' ? input.extraction.sourceDocumentId : null,
    extractionRawValues:
      input.origin === 'extracted' ? input.extraction.rawValues : null,
    extractionFieldSources:
      input.origin === 'extracted' ? input.extraction.fieldSources : null,
    extractionCurrent:
      input.origin === 'extracted' ? input.extraction.current : null
  };
}

async function insertDetailsBatch(
  executor: QueryExecutor,
  claimsWithIds: ClaimWithId[]
): Promise<void> {
  const skillRows: (typeof skillDetails.$inferInsert)[] = [];
  const employmentRows: (typeof employmentDetails.$inferInsert)[] = [];
  const educationRows: (typeof educationDetails.$inferInsert)[] = [];
  const certificationRows: (typeof certificationDetails.$inferInsert)[] = [];
  const languageRows: (typeof languageDetails.$inferInsert)[] = [];
  const projectRows: (typeof projectDetails.$inferInsert)[] = [];

  for (const { claimId, input } of claimsWithIds) {
    switch (input.claimType) {
      case 'skill':
        skillRows.push({ claimId, ...toSkillRow(input.values) });
        break;
      case 'employment':
        employmentRows.push({ claimId, ...toEmploymentRow(input.values) });
        break;
      case 'education':
        educationRows.push({ claimId, ...toEducationRow(input.values) });
        break;
      case 'certification':
        certificationRows.push({
          claimId,
          ...toCertificationRow(input.values)
        });
        break;
      case 'language':
        languageRows.push({ claimId, ...toLanguageRow(input.values) });
        break;
      case 'project':
        projectRows.push({ claimId, ...toProjectRow(input.values) });
        break;
    }
  }

  if (skillRows.length > 0) {
    await executor.insert(skillDetails).values(skillRows);
  }
  if (employmentRows.length > 0) {
    await executor.insert(employmentDetails).values(employmentRows);
  }
  if (educationRows.length > 0) {
    await executor.insert(educationDetails).values(educationRows);
  }
  if (certificationRows.length > 0) {
    await executor.insert(certificationDetails).values(certificationRows);
  }
  if (languageRows.length > 0) {
    await executor.insert(languageDetails).values(languageRows);
  }
  if (projectRows.length > 0) {
    await executor.insert(projectDetails).values(projectRows);
  }
}

async function updateDetails(
  executor: QueryExecutor,
  claimId: string,
  claimType: ClaimRow['claimType'],
  values: ClaimValues
): Promise<void> {
  switch (claimType) {
    case 'skill':
      await executor
        .update(skillDetails)
        .set(toSkillRow(values))
        .where(eq(skillDetails.claimId, claimId));
      break;
    case 'employment':
      await executor
        .update(employmentDetails)
        .set(toEmploymentRow(values))
        .where(eq(employmentDetails.claimId, claimId));
      break;
    case 'education':
      await executor
        .update(educationDetails)
        .set(toEducationRow(values))
        .where(eq(educationDetails.claimId, claimId));
      break;
    case 'certification':
      await executor
        .update(certificationDetails)
        .set(toCertificationRow(values))
        .where(eq(certificationDetails.claimId, claimId));
      break;
    case 'language':
      await executor
        .update(languageDetails)
        .set(toLanguageRow(values))
        .where(eq(languageDetails.claimId, claimId));
      break;
    case 'project':
      await executor
        .update(projectDetails)
        .set(toProjectRow(values))
        .where(eq(projectDetails.claimId, claimId));
      break;
  }
}

async function selectClaims(
  executor: QueryExecutor,
  where: SQL | undefined
): Promise<ClaimRecord[]> {
  const rows = await executor
    .select({
      claim: claims,
      skill: skillDetails,
      employment: employmentDetails,
      education: educationDetails,
      certification: certificationDetails,
      language: languageDetails,
      project: projectDetails
    })
    .from(claims)
    .leftJoin(skillDetails, eq(skillDetails.claimId, claims.claimId))
    .leftJoin(employmentDetails, eq(employmentDetails.claimId, claims.claimId))
    .leftJoin(educationDetails, eq(educationDetails.claimId, claims.claimId))
    .leftJoin(
      certificationDetails,
      eq(certificationDetails.claimId, claims.claimId)
    )
    .leftJoin(languageDetails, eq(languageDetails.claimId, claims.claimId))
    .leftJoin(projectDetails, eq(projectDetails.claimId, claims.claimId))
    .where(where)
    .orderBy(asc(claims.createdAt));

  return rows.map(({ claim, skill, employment, education, certification, language, project }) => {
    let values: ClaimValues = {};

    if (claim.claimType === 'skill' && skill) {
      values = compactValues({ name: skill.name });
    } else if (claim.claimType === 'employment' && employment) {
      values = compactValues({
        employer: employment.employer,
        jobTitle: employment.jobTitle,
        startDate: fromStoredDate(
          employment.startDate,
          employment.startDatePrecision
        ),
        endDate: fromStoredDate(employment.endDate, employment.endDatePrecision),
        location: employment.location,
        description: employment.description,
        skills: employment.skills
      });
    } else if (claim.claimType === 'education' && education) {
      values = compactValues({
        institution: education.institution,
        degree: education.degree,
        fieldOfStudy: education.fieldOfStudy,
        startDate: fromStoredDate(education.startDate, education.startDatePrecision),
        endDate: fromStoredDate(education.endDate, education.endDatePrecision)
      });
    } else if (claim.claimType === 'certification' && certification) {
      values = compactValues({
        title: certification.title,
        issuer: certification.issuer,
        issueDate: fromStoredDate(
          certification.issueDate,
          certification.issueDatePrecision
        ),
        expiryDate: fromStoredDate(
          certification.expiryDate,
          certification.expiryDatePrecision
        ),
        credentialId: certification.credentialId
      });
    } else if (claim.claimType === 'language' && language) {
      values = compactValues({
        name: language.name,
        proficiency: language.proficiency
      });
    } else if (claim.claimType === 'project' && project) {
      values = compactValues({
        name: project.name,
        description: project.description,
        role: project.role,
        url: project.url,
        startDate: fromStoredDate(project.startDate, project.startDatePrecision),
        endDate: fromStoredDate(project.endDate, project.endDatePrecision),
        skills: project.skills
      });
    }

    return {
      claimId: claim.claimId,
      supersededByClaimId: claim.supersededByClaimId,
      claimType: claim.claimType,
      origin: claim.origin,
      status: claim.status,
      current: claim.current,
      candidateEdited: claim.candidateEditedAt !== null,
      values,
      extraction:
        claim.origin === 'extracted' &&
          claim.extractionInvocationId !== null &&
          claim.extractionRawValues !== null &&
          claim.extractionFieldSources !== null &&
          claim.extractionCurrent !== null
          ? {
            invocationId: claim.extractionInvocationId,
            sourceDocumentId: claim.extractionDocumentId,
            rawValues: claim.extractionRawValues,
            fieldSources: claim.extractionFieldSources,
            current: claim.extractionCurrent
          }
          : null,
      version: claim.version,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt
    };
  });
}

async function insertClaim(
  executor: QueryExecutor,
  input: CreateClaimInput
): Promise<ClaimRecord> {
  const [createdClaim] = await executor
    .insert(claims)
    .values({
      candidateId: input.candidateId,
      claimType: input.claimType,
      origin: input.origin,
      status: input.status,
      current: input.origin === 'extracted' ? input.extraction.current : false,
      extractionInvocationId:
        input.origin === 'extracted' ? input.extraction.invocationId : null,
      extractionDocumentId:
        input.origin === 'extracted' ? input.extraction.sourceDocumentId : null,
      extractionRawValues:
        input.origin === 'extracted' ? input.extraction.rawValues : null,
      extractionFieldSources:
        input.origin === 'extracted' ? input.extraction.fieldSources : null,
      extractionCurrent:
        input.origin === 'extracted' ? input.extraction.current : null
    })
    .returning({ claimId: claims.claimId });

  if (!createdClaim) {
    throw new Error('Claim creation did not return a record');
  }

  await insertDetails(
    executor,
    createdClaim.claimId,
    input.claimType,
    input.values
  );

  const [claim] = await selectClaims(
    executor,
    eq(claims.claimId, createdClaim.claimId)
  );
  if (!claim) {
    throw new Error('Created claim could not be read');
  }
  return claim;
}

async function insertClaims(
  executor: QueryExecutor,
  inputs: CreateClaimInput[]
): Promise<ClaimRecord[]> {
  if (inputs.length === 0) {
    return [];
  }

  const claimsWithIds = inputs.map((input) => ({
    claimId: randomUUID(),
    input
  }));
  await executor.insert(claims).values(claimsWithIds.map(toClaimInsert));
  await insertDetailsBatch(executor, claimsWithIds);

  const claimIds = claimsWithIds.map(({ claimId }) => claimId);
  const createdClaims = await selectClaims(
    executor,
    inArray(claims.claimId, claimIds)
  );
  const claimsById = new Map(
    createdClaims.map((claim) => [claim.claimId, claim])
  );

  return claimIds.map((claimId) => {
    const claim = claimsById.get(claimId);
    if (!claim) {
      throw new Error('Created claim could not be read');
    }
    return claim;
  });
}

async function transferClaimSourceOccurrences(
  transaction: DatabaseExecutor,
  duplicateClaimId: string,
  survivorClaimId: string
): Promise<TransferClaimSourceOccurrencesResult> {
  if (duplicateClaimId === survivorClaimId) {
    return { moved: 0, skipped: 0 };
  }

  const occurrences = await transaction
    .select({
      occurrenceId: sourceOccurrences.occurrenceId,
      claimId: sourceOccurrences.claimId,
      documentId: sourceOccurrences.documentId,
      anchorKey: sourceOccurrences.anchorKey
    })
    .from(sourceOccurrences)
    .where(
      inArray(sourceOccurrences.claimId, [duplicateClaimId, survivorClaimId])
    );
  const physicalKey = (documentId: string, anchorKey: string) =>
    `${documentId}\u0000${anchorKey}`;
  const survivorKeys = new Set(
    occurrences
      .filter(({ claimId }) => claimId === survivorClaimId)
      .map(({ documentId, anchorKey }) => physicalKey(documentId, anchorKey))
  );
  const duplicateOccurrences = occurrences.filter(
    ({ claimId }) => claimId === duplicateClaimId
  );
  const duplicateOccurrenceIds = duplicateOccurrences
    .filter(({ documentId, anchorKey }) =>
      survivorKeys.has(physicalKey(documentId, anchorKey))
    )
    .map(({ occurrenceId }) => occurrenceId);

  if (duplicateOccurrenceIds.length > 0) {
    await transaction
      .delete(sourceOccurrences)
      .where(inArray(sourceOccurrences.occurrenceId, duplicateOccurrenceIds));
  }
  if (duplicateOccurrences.length === duplicateOccurrenceIds.length) {
    return { moved: 0, skipped: duplicateOccurrenceIds.length };
  }

  const moved = await transaction
    .update(sourceOccurrences)
    .set({ claimId: survivorClaimId })
    .where(eq(sourceOccurrences.claimId, duplicateClaimId))
    .returning({ occurrenceId: sourceOccurrences.occurrenceId });
  return { moved: moved.length, skipped: duplicateOccurrenceIds.length };
}

async function snapshotAutoMergeClaims(
  transaction: DatabaseExecutor,
  records: ClaimRecord[]
): Promise<AutoMergeClaimSnapshot[]> {
  const claimIds = records.map(({ claimId }) => claimId);
  const occurrences = claimIds.length > 0
    ? await transaction
        .select({
          occurrenceId: sourceOccurrences.occurrenceId,
          claimId: sourceOccurrences.claimId,
          documentId: sourceOccurrences.documentId,
          anchorKey: sourceOccurrences.anchorKey,
          sourceReferences: sourceOccurrences.sourceReferences,
          fieldNames: sourceOccurrences.fieldNames,
          anchor: sourceOccurrences.anchor
        })
        .from(sourceOccurrences)
        .where(inArray(sourceOccurrences.claimId, claimIds))
    : [];

  return records.map((record) => ({
    claimId: record.claimId,
    claimType: record.claimType,
    origin: record.origin,
    status: record.status,
    current: record.current,
    values: record.values,
    version: record.version,
    sourceDocumentId: record.extraction?.sourceDocumentId ?? null,
    sources: occurrences
      .filter(({ claimId }) => claimId === record.claimId)
      .sort((left, right) => left.anchorKey.localeCompare(right.anchorKey))
      .map(({ documentId, anchorKey, sourceReferences, fieldNames, anchor }) => ({
        documentId,
        anchorKey,
        sourceReferences,
        fieldNames,
        anchor
      }))
  }));
}

export function createCandidatesRepository(
  database: AppDatabase
): CandidatesRepository {
  return {
    async findCandidateByUserId(userId, transaction = database.db) {
      return withDbErrors('Candidate', async () => {
        const [candidate] = await transaction
          .select()
          .from(candidates)
          .where(eq(candidates.userId, userId))
          .limit(1);

        return candidate ?? null;
      });
    },

    async createCandidate(input) {
      return withDbErrors('Candidate', async () => {
        const [createdCandidate] = await database.db
          .insert(candidates)
          .values(input)
          .returning();

        if (!createdCandidate) {
          throw new Error('Candidate creation did not return a record');
        }

        return createdCandidate;
      });
    },

    // Every update increases the version. With an expected version, the update
    // only happens if the profile still has it.
    async updateCandidate(candidateId, input, expectedVersion) {
      return withDbErrors('Candidate', async (): Promise<VersionedWrite<CandidateRecord>> => {
        const [updatedCandidate] = await database.db
          .update(candidates)
          .set({ ...input, version: sql`${candidates.version} + 1` })
          .where(
            and(
              eq(candidates.candidateId, candidateId),
              expectedVersion === undefined
                ? undefined
                : eq(candidates.version, expectedVersion)
            )
          )
          .returning();

        if (updatedCandidate) {
          return { status: 'saved', record: updatedCandidate };
        }

        const [current] = await database.db
          .select()
          .from(candidates)
          .where(eq(candidates.candidateId, candidateId))
          .limit(1);

        return current ? { status: 'conflict', current } : { status: 'missing' };
      });
    },

    // A caller-owned transaction lets extraction save all claims and unmapped
    // data atomically. Manual creation keeps its own retried transaction.
    async createClaim(input, transaction) {
      if (transaction) {
        return withDbErrors('Claim', () => insertClaim(transaction, input));
      }

      return withTransientRetry(() =>
        withDbErrors('Claim', () =>
          database.db.transaction((createdTransaction) =>
            insertClaim(createdTransaction, input)
          )
        )
      );
    },

    async createClaims(inputs, transaction) {
      return withDbErrors('Claims', () =>
        insertClaims(transaction, inputs)
      );
    },

    async createClaimSourceOccurrences(inputs, transaction) {
      if (inputs.length === 0) {
        return 0;
      }
      // A document processed again adds the same sources to claims it was
      // already a source of; those are kept once.
      return withDbErrors('Claim source occurrences', async () => {
        const inserted = await transaction
          .insert(sourceOccurrences)
          .values(inputs)
          .onConflictDoNothing()
          .returning({ occurrenceId: sourceOccurrences.occurrenceId });
        return inserted.length;
      });
    },

    async transferClaimSourceOccurrences(
      duplicateClaimId,
      survivorClaimId,
      transaction
    ) {
      if (duplicateClaimId === survivorClaimId) {
        return { moved: 0, skipped: 0 };
      }

      return withDbErrors('Claim source occurrences', () =>
        transferClaimSourceOccurrences(
          transaction,
          duplicateClaimId,
          survivorClaimId
        )
      );
    },

    async coalescePendingClaims(input) {
      if (input.survivor.claimId === input.duplicate.claimId) {
        return { status: 'not_eligible', current: [] };
      }

      return withTransientRetry(() =>
        withDbErrors('Claims', () =>
          database.db.transaction(
            async (transaction): Promise<CoalescePendingClaimsResult> => {
              const claimIds = [
                input.survivor.claimId,
                input.duplicate.claimId
              ].sort();
              const locked = await transaction
                .select({ claimId: claims.claimId })
                .from(claims)
                .where(
                  and(
                    eq(claims.candidateId, input.candidateId),
                    inArray(claims.claimId, claimIds)
                  )
                )
                .orderBy(asc(claims.claimId))
                .for('update');
              if (locked.length !== 2) {
                return { status: 'missing' };
              }

              const current = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, input.candidateId),
                  inArray(claims.claimId, claimIds)
                )
              );
              const claimsById = new Map(
                current.map((claim) => [claim.claimId, claim])
              );
              const survivor = claimsById.get(input.survivor.claimId);
              const duplicate = claimsById.get(input.duplicate.claimId);
              if (!survivor || !duplicate) {
                return { status: 'missing' };
              }
              if (
                survivor.version !== input.survivor.expectedVersion ||
                duplicate.version !== input.duplicate.expectedVersion
              ) {
                return { status: 'conflict', current };
              }
              const eligible =
                survivor.claimType === duplicate.claimType &&
                survivor.origin === 'extracted' &&
                duplicate.origin === 'extracted' &&
                survivor.status === 'pending' &&
                duplicate.status === 'pending' &&
                !survivor.candidateEdited &&
                !duplicate.candidateEdited &&
                survivor.supersededByClaimId === null &&
                duplicate.supersededByClaimId === null;
              if (!eligible) {
                return { status: 'not_eligible', current };
              }

              const claimsBefore = await snapshotAutoMergeClaims(transaction, [
                survivor,
                duplicate
              ]);

              const mergedCurrent = input.current ?? survivor.current;
              const valuesChanged = !haveSameClaimValues(
                survivor.values,
                input.values
              );
              if (valuesChanged || survivor.current !== mergedCurrent) {
                await transaction.insert(claimRevisions).values({
                  claimId: survivor.claimId,
                  previousValues: survivor.values,
                  previousCurrent: survivor.current
                });
              }
              if (valuesChanged) {
                await updateDetails(
                  transaction,
                  survivor.claimId,
                  survivor.claimType,
                  input.values
                );
              }

              const updatedAt = new Date();
              await transaction
                .update(claims)
                .set({
                  status: 'auto_accepted',
                  current: mergedCurrent,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, survivor.claimId));
              await transaction.insert(claimAutoMergeNotices).values({
                candidateId: input.candidateId,
                survivorClaimId: survivor.claimId,
                supersededClaimIds: [duplicate.claimId],
                messages: input.messages,
                claimsBefore,
                status: 'pending'
              });
              await transferClaimSourceOccurrences(
                transaction,
                duplicate.claimId,
                survivor.claimId
              );
              await transaction
                .update(claims)
                .set({
                  supersededByClaimId: survivor.claimId,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, duplicate.claimId));

              const saved = await selectClaims(
                transaction,
                inArray(claims.claimId, claimIds)
              );
              const savedById = new Map(
                saved.map((claim) => [claim.claimId, claim])
              );
              const savedSurvivor = savedById.get(survivor.claimId);
              const savedDuplicate = savedById.get(duplicate.claimId);
              if (!savedSurvivor || !savedDuplicate) {
                throw new Error('Coalesced claims could not be read');
              }
              return {
                status: 'saved',
                survivor: savedSurvivor,
                duplicate: savedDuplicate
              };
            }
          )
        )
      );
    },

    async autoAcceptMergeClaims(input) {
      if (input.survivor.claimId === input.duplicate.claimId) {
        return { status: 'not_eligible', current: [] };
      }

      return withTransientRetry(() =>
        withDbErrors('Claims', () =>
          database.db.transaction(
            async (transaction): Promise<AutoAcceptMergeClaimsResult> => {
              const claimIds = [
                input.survivor.claimId,
                input.duplicate.claimId
              ].sort();
              const locked = await transaction
                .select({ claimId: claims.claimId })
                .from(claims)
                .where(
                  and(
                    eq(claims.candidateId, input.candidateId),
                    inArray(claims.claimId, claimIds)
                  )
                )
                .orderBy(asc(claims.claimId))
                .for('update');
              if (locked.length !== 2) {
                return { status: 'missing' };
              }

              const current = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, input.candidateId),
                  inArray(claims.claimId, claimIds)
                )
              );
              const claimsById = new Map(
                current.map((claim) => [claim.claimId, claim])
              );
              const survivor = claimsById.get(input.survivor.claimId);
              const duplicate = claimsById.get(input.duplicate.claimId);
              if (!survivor || !duplicate) {
                return { status: 'missing' };
              }
              if (
                survivor.version !== input.survivor.expectedVersion ||
                duplicate.version !== input.duplicate.expectedVersion
              ) {
                return { status: 'conflict', current };
              }
              const eligible =
                survivor.claimType === duplicate.claimType &&
                survivor.supersededByClaimId === null &&
                duplicate.supersededByClaimId === null &&
                (survivor.status === 'pending' ||
                  survivor.status === 'accepted' ||
                  survivor.status === 'auto_accepted') &&
                (duplicate.status === 'pending' ||
                  duplicate.status === 'accepted' ||
                  duplicate.status === 'auto_accepted');
              if (!eligible) {
                return { status: 'not_eligible', current };
              }

              const claimsBefore = await snapshotAutoMergeClaims(transaction, [
                survivor,
                duplicate
              ]);

              const mergedCurrent = input.current ?? survivor.current;
              const valuesChanged = !haveSameClaimValues(
                survivor.values,
                input.values
              );
              if (valuesChanged || survivor.current !== mergedCurrent) {
                await transaction.insert(claimRevisions).values({
                  claimId: survivor.claimId,
                  previousValues: survivor.values,
                  previousCurrent: survivor.current
                });
              }
              if (valuesChanged) {
                await updateDetails(
                  transaction,
                  survivor.claimId,
                  survivor.claimType,
                  input.values
                );
              }

              const updatedAt = new Date();
              await transaction
                .update(claims)
                .set({
                  status: 'auto_accepted',
                  current: mergedCurrent,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, survivor.claimId));
              await transaction.insert(claimAutoMergeNotices).values({
                candidateId: input.candidateId,
                survivorClaimId: survivor.claimId,
                supersededClaimIds: [duplicate.claimId],
                messages: input.messages,
                claimsBefore,
                status: 'pending'
              });
              await transferClaimSourceOccurrences(
                transaction,
                duplicate.claimId,
                survivor.claimId
              );
              await transaction
                .update(claims)
                .set({
                  supersededByClaimId: survivor.claimId,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, duplicate.claimId));

              const saved = await selectClaims(
                transaction,
                inArray(claims.claimId, claimIds)
              );
              const savedById = new Map(
                saved.map((claim) => [claim.claimId, claim])
              );
              const savedSurvivor = savedById.get(survivor.claimId);
              const savedDuplicate = savedById.get(duplicate.claimId);
              if (!savedSurvivor || !savedDuplicate) {
                throw new Error('Auto-merged claims could not be read');
              }
              const [notice] = await transaction
                .select()
                .from(claimAutoMergeNotices)
                .where(
                  and(
                    eq(claimAutoMergeNotices.survivorClaimId, survivor.claimId),
                    eq(claimAutoMergeNotices.status, 'pending')
                  )
                )
                .orderBy(desc(claimAutoMergeNotices.createdAt))
                .limit(1);
              if (!notice) {
                throw new Error('Auto-merge notice could not be read');
              }
              return {
                status: 'saved',
                survivor: savedSurvivor,
                duplicate: savedDuplicate,
                notice
              };
            }
          )
        )
      );
    },

    async acknowledgeAutoMergeNotices(candidateId, survivorClaimId) {
      return withDbErrors('Claims', async () => {
        const acknowledged = await database.db
          .update(claimAutoMergeNotices)
          .set({
            status: 'acknowledged',
            acknowledgedAt: new Date(),
            updatedAt: new Date()
          })
          .where(
            and(
              eq(claimAutoMergeNotices.candidateId, candidateId),
              eq(claimAutoMergeNotices.survivorClaimId, survivorClaimId),
              eq(claimAutoMergeNotices.status, 'pending')
            )
          )
          .returning({ noticeId: claimAutoMergeNotices.noticeId });
        return acknowledged.length;
      });
    },

    async countOpenAutoMergeNotices(candidateId, survivorClaimId) {
      return withDbErrors('Claims', async () => {
        const open = await database.db
          .select({ noticeId: claimAutoMergeNotices.noticeId })
          .from(claimAutoMergeNotices)
          .where(
            and(
              eq(claimAutoMergeNotices.candidateId, candidateId),
              eq(claimAutoMergeNotices.survivorClaimId, survivorClaimId),
              eq(claimAutoMergeNotices.status, 'pending')
            )
          );
        return open.length;
      });
    },

    async listOpenAutoMergeNotices(candidateId, survivorClaimIds) {
      if (survivorClaimIds && survivorClaimIds.length === 0) {
        return [];
      }
      return withDbErrors('Claims', async () => {
        return database.db
          .select()
          .from(claimAutoMergeNotices)
          .where(
            and(
              eq(claimAutoMergeNotices.candidateId, candidateId),
              eq(claimAutoMergeNotices.status, 'pending'),
              survivorClaimIds && survivorClaimIds.length > 0
                ? inArray(claimAutoMergeNotices.survivorClaimId, survivorClaimIds)
                : undefined
            )
          )
          .orderBy(desc(claimAutoMergeNotices.createdAt));
      });
    },

    async keepAutoMergedClaimsSeparate(
      candidateId,
      survivorClaimId,
      expectedVersion
    ) {
      return withTransientRetry(() =>
        withDbErrors('Claims', () =>
          database.db.transaction(
            async (transaction): Promise<KeepAutoMergedClaimsSeparateResult> => {
              const notices = await transaction
                .select()
                .from(claimAutoMergeNotices)
                .where(
                  and(
                    eq(claimAutoMergeNotices.candidateId, candidateId),
                    eq(claimAutoMergeNotices.survivorClaimId, survivorClaimId),
                    eq(claimAutoMergeNotices.status, 'pending')
                  )
                )
                .orderBy(asc(claimAutoMergeNotices.createdAt))
                .for('update');
              if (notices.length === 0) {
                const current = await selectClaims(
                  transaction,
                  and(
                    eq(claims.candidateId, candidateId),
                    eq(claims.claimId, survivorClaimId)
                  )
                );
                return current.length === 0
                  ? { status: 'missing' }
                  : { status: 'not_eligible', current };
              }
              if (notices.some(({ claimsBefore }) => !claimsBefore)) {
                const current = await selectClaims(
                  transaction,
                  and(
                    eq(claims.candidateId, candidateId),
                    eq(claims.claimId, survivorClaimId)
                  )
                );
                return { status: 'not_eligible', current };
              }

              // The first snapshot for a claim is its state before this chain
              // of automatic merges. Later survivor snapshots include earlier
              // enrichments and therefore must not replace it.
              const snapshots = new Map<string, AutoMergeClaimSnapshot>();
              for (const notice of notices) {
                for (const snapshot of notice.claimsBefore ?? []) {
                  if (!snapshots.has(snapshot.claimId)) {
                    snapshots.set(snapshot.claimId, snapshot);
                  }
                }
              }
              const survivorSnapshot = snapshots.get(survivorClaimId);
              if (!survivorSnapshot || snapshots.size < 2) {
                return { status: 'not_eligible', current: [] };
              }

              const claimIds = [...snapshots.keys()].sort();
              const locked = await transaction
                .select({ claimId: claims.claimId })
                .from(claims)
                .where(
                  and(
                    eq(claims.candidateId, candidateId),
                    inArray(claims.claimId, claimIds)
                  )
                )
                .orderBy(asc(claims.claimId))
                .for('update');
              if (locked.length !== claimIds.length) {
                return { status: 'missing' };
              }

              const current = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, candidateId),
                  inArray(claims.claimId, claimIds)
                )
              );
              const currentById = new Map(
                current.map((claim) => [claim.claimId, claim])
              );
              const survivor = currentById.get(survivorClaimId);
              if (!survivor) {
                return { status: 'missing' };
              }
              if (
                expectedVersion !== undefined &&
                survivor.version !== expectedVersion
              ) {
                return { status: 'conflict', current };
              }
              const eligible =
                survivor.status === 'auto_accepted' &&
                survivor.supersededByClaimId === null &&
                claimIds.every((claimId) => {
                  const claim = currentById.get(claimId);
                  const snapshot = snapshots.get(claimId);
                  return Boolean(
                    claim &&
                      snapshot &&
                      claim.claimType === snapshot.claimType &&
                      (claimId === survivorClaimId ||
                        claim.supersededByClaimId === survivorClaimId)
                  );
                });
              if (!eligible) {
                return { status: 'not_eligible', current };
              }

              const updatedAt = new Date();
              for (const snapshot of snapshots.values()) {
                const claim = currentById.get(snapshot.claimId)!;
                if (
                  !haveSameClaimValues(claim.values, snapshot.values) ||
                  claim.current !== snapshot.current
                ) {
                  await transaction.insert(claimRevisions).values({
                    claimId: claim.claimId,
                    previousValues: claim.values,
                    previousCurrent: claim.current
                  });
                }
                if (!haveSameClaimValues(claim.values, snapshot.values)) {
                  await updateDetails(
                    transaction,
                    claim.claimId,
                    claim.claimType,
                    snapshot.values
                  );
                }
                await transaction
                  .update(claims)
                  .set({
                    status: snapshot.status,
                    current: snapshot.current,
                    supersededByClaimId: null,
                    updatedAt,
                    version: sql`${claims.version} + 1`
                  })
                  .where(eq(claims.claimId, claim.claimId));
              }

              await transaction
                .delete(sourceOccurrences)
                .where(inArray(sourceOccurrences.claimId, claimIds));
              const restoredSources = [...snapshots.values()].flatMap(
                (snapshot) =>
                  snapshot.sources.map((source) => ({
                    claimId: snapshot.claimId,
                    documentId: source.documentId,
                    anchorKey: source.anchorKey,
                    sourceReferences: source.sourceReferences,
                    fieldNames: source.fieldNames,
                    anchor: source.anchor
                  }))
              );
              if (restoredSources.length > 0) {
                await transaction.insert(sourceOccurrences).values(restoredSources);
              }

              await transaction
                .update(claimAutoMergeNotices)
                .set({ status: 'reverted', updatedAt })
                .where(
                  inArray(
                    claimAutoMergeNotices.noticeId,
                    notices.map(({ noticeId }) => noticeId)
                  )
                );

              const saved = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, candidateId),
                  inArray(claims.claimId, claimIds)
                )
              );
              const savedById = new Map(saved.map((claim) => [claim.claimId, claim]));
              for (const duplicateId of claimIds.filter(
                (claimId) => claimId !== survivorClaimId
              )) {
                const pair = [survivorClaimId, duplicateId].sort();
                const left = savedById.get(pair[0]!);
                const right = savedById.get(pair[1]!);
                if (!left || !right) continue;
                await transaction
                  .insert(claimPairDecisions)
                  .values({
                    candidateId,
                    leftClaimId: left.claimId,
                    rightClaimId: right.claimId,
                    leftVersion: left.version,
                    rightVersion: right.version,
                    decision: 'different',
                    updatedAt
                  })
                  .onConflictDoUpdate({
                    target: [
                      claimPairDecisions.candidateId,
                      claimPairDecisions.leftClaimId,
                      claimPairDecisions.rightClaimId
                    ],
                    set: {
                      leftVersion: left.version,
                      rightVersion: right.version,
                      decision: 'different',
                      updatedAt
                    }
                  });
              }
              return { status: 'saved', claims: saved };
            }
          )
        )
      );
    },

    async mergeConfirmedClaims(input) {
      if (input.survivor.claimId === input.duplicate.claimId) {
        return { status: 'not_eligible', current: [] };
      }

      return withTransientRetry(() =>
        withDbErrors('Claims', () =>
          database.db.transaction(
            async (transaction): Promise<MergeConfirmedClaimsResult> => {
              const claimIds = [
                input.survivor.claimId,
                input.duplicate.claimId
              ].sort();
              const locked = await transaction
                .select({ claimId: claims.claimId })
                .from(claims)
                .where(
                  and(
                    eq(claims.candidateId, input.candidateId),
                    inArray(claims.claimId, claimIds)
                  )
                )
                .orderBy(asc(claims.claimId))
                .for('update');
              if (locked.length !== 2) {
                return { status: 'missing' };
              }

              const current = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, input.candidateId),
                  inArray(claims.claimId, claimIds)
                )
              );
              const claimsById = new Map(
                current.map((claim) => [claim.claimId, claim])
              );
              const survivor = claimsById.get(input.survivor.claimId);
              const duplicate = claimsById.get(input.duplicate.claimId);
              if (!survivor || !duplicate) {
                return { status: 'missing' };
              }
              if (
                survivor.version !== input.survivor.expectedVersion ||
                duplicate.version !== input.duplicate.expectedVersion
              ) {
                return { status: 'conflict', current };
              }
              const eligible =
                survivor.claimType === duplicate.claimType &&
                survivor.status !== 'rejected' &&
                duplicate.status !== 'rejected' &&
                survivor.supersededByClaimId === null &&
                duplicate.supersededByClaimId === null;
              if (!eligible) {
                return { status: 'not_eligible', current };
              }

              const mergedCurrent = input.current ?? survivor.current;
              const valuesChanged = !haveSameClaimValues(
                survivor.values,
                input.values
              );
              if (valuesChanged || survivor.current !== mergedCurrent) {
                await transaction.insert(claimRevisions).values({
                  claimId: survivor.claimId,
                  previousValues: survivor.values,
                  previousCurrent: survivor.current
                });
              }
              if (valuesChanged) {
                await updateDetails(
                  transaction,
                  survivor.claimId,
                  survivor.claimType,
                  input.values
                );
              }

              const updatedAt = new Date();
              await transaction
                .update(claims)
                .set({
                  status: 'accepted',
                  current: mergedCurrent,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, survivor.claimId));
              await transferClaimSourceOccurrences(
                transaction,
                duplicate.claimId,
                survivor.claimId
              );
              await transaction
                .update(claims)
                .set({
                  supersededByClaimId: survivor.claimId,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, duplicate.claimId));

              const saved = await selectClaims(
                transaction,
                inArray(claims.claimId, claimIds)
              );
              const savedById = new Map(
                saved.map((claim) => [claim.claimId, claim])
              );
              const savedSurvivor = savedById.get(survivor.claimId);
              const savedDuplicate = savedById.get(duplicate.claimId);
              if (!savedSurvivor || !savedDuplicate) {
                throw new Error('Merged claims could not be read');
              }
              return {
                status: 'saved',
                survivor: savedSurvivor,
                duplicate: savedDuplicate
              };
            }
          )
        )
      );
    },

    async mergeConfirmedClaimGroup(input) {
      const claimIds = input.claims.map(({ claimId }) => claimId);
      const uniqueClaimIds = [...new Set(claimIds)].sort();
      if (
        uniqueClaimIds.length < 2 ||
        uniqueClaimIds.length !== claimIds.length ||
        !uniqueClaimIds.includes(input.survivorClaimId)
      ) {
        return { status: 'not_eligible', current: [] };
      }

      return withTransientRetry(() =>
        withDbErrors('Claims', () =>
          database.db.transaction(
            async (transaction): Promise<MergeConfirmedClaimGroupResult> => {
              const locked = await transaction
                .select({ claimId: claims.claimId })
                .from(claims)
                .where(
                  and(
                    eq(claims.candidateId, input.candidateId),
                    inArray(claims.claimId, uniqueClaimIds)
                  )
                )
                .orderBy(asc(claims.claimId))
                .for('update');
              if (locked.length !== uniqueClaimIds.length) {
                return { status: 'missing' };
              }

              const current = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, input.candidateId),
                  inArray(claims.claimId, uniqueClaimIds)
                )
              );
              const claimsById = new Map(
                current.map((claim) => [claim.claimId, claim])
              );
              const survivor = claimsById.get(input.survivorClaimId);
              if (!survivor || current.length !== uniqueClaimIds.length) {
                return { status: 'missing' };
              }

              const expectedVersions = new Map(
                input.claims.map(({ claimId, expectedVersion }) => [
                  claimId,
                  expectedVersion
                ])
              );
              if (
                current.some(
                  (claim) => expectedVersions.get(claim.claimId) !== claim.version
                )
              ) {
                return { status: 'conflict', current };
              }
              const eligible = current.every(
                (claim) =>
                  claim.claimType === survivor.claimType &&
                  claim.status !== 'rejected' &&
                  claim.supersededByClaimId === null
              );
              if (!eligible) {
                return { status: 'not_eligible', current };
              }

              const mergedCurrent = input.current ?? survivor.current;
              const valuesChanged = !haveSameClaimValues(
                survivor.values,
                input.values
              );
              if (valuesChanged || survivor.current !== mergedCurrent) {
                await transaction.insert(claimRevisions).values({
                  claimId: survivor.claimId,
                  previousValues: survivor.values,
                  previousCurrent: survivor.current
                });
              }
              if (valuesChanged) {
                await updateDetails(
                  transaction,
                  survivor.claimId,
                  survivor.claimType,
                  input.values
                );
              }

              const duplicateClaimIds = uniqueClaimIds.filter(
                (claimId) => claimId !== survivor.claimId
              );
              for (const duplicateClaimId of duplicateClaimIds) {
                await transferClaimSourceOccurrences(
                  transaction,
                  duplicateClaimId,
                  survivor.claimId
                );
              }

              const updatedAt = new Date();
              await transaction
                .update(claims)
                .set({
                  status: 'accepted',
                  current: mergedCurrent,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(eq(claims.claimId, survivor.claimId));
              await transaction
                .update(claims)
                .set({
                  supersededByClaimId: survivor.claimId,
                  updatedAt,
                  version: sql`${claims.version} + 1`
                })
                .where(inArray(claims.claimId, duplicateClaimIds));

              const saved = await selectClaims(
                transaction,
                inArray(claims.claimId, uniqueClaimIds)
              );
              const savedById = new Map(
                saved.map((claim) => [claim.claimId, claim])
              );
              const savedSurvivor = savedById.get(survivor.claimId);
              const savedDuplicates = duplicateClaimIds.map((claimId) =>
                savedById.get(claimId)
              );
              if (!savedSurvivor || savedDuplicates.some((claim) => !claim)) {
                throw new Error('Merged claim group could not be read');
              }
              const duplicates = savedDuplicates.map((claim) => {
                if (!claim) {
                  throw new Error('Merged claim group duplicate could not be read');
                }
                return claim;
              });
              return {
                status: 'saved',
                survivor: savedSurvivor,
                duplicates
              };
            }
          )
        )
      );
    },

    async recordClaimsDifferent(input) {
      if (input.left.claimId === input.right.claimId) {
        return { status: 'not_eligible', current: [] };
      }

      const [leftInput, rightInput] = [input.left, input.right].sort(
        (left, right) => left.claimId.localeCompare(right.claimId)
      );
      if (!leftInput || !rightInput) {
        throw new Error('Claim pair could not be ordered');
      }

      return withTransientRetry(() =>
        withDbErrors('Claim pair decision', () =>
          database.db.transaction(
            async (transaction): Promise<RecordClaimsDifferentResult> => {
              const claimIds = [leftInput.claimId, rightInput.claimId];
              const locked = await transaction
                .select({ claimId: claims.claimId })
                .from(claims)
                .where(
                  and(
                    eq(claims.candidateId, input.candidateId),
                    inArray(claims.claimId, claimIds)
                  )
                )
                .orderBy(asc(claims.claimId))
                .for('update');
              if (locked.length !== 2) {
                return { status: 'missing' };
              }

              const current = await selectClaims(
                transaction,
                and(
                  eq(claims.candidateId, input.candidateId),
                  inArray(claims.claimId, claimIds)
                )
              );
              const claimsById = new Map(
                current.map((claim) => [claim.claimId, claim])
              );
              const left = claimsById.get(leftInput.claimId);
              const right = claimsById.get(rightInput.claimId);
              if (!left || !right) {
                return { status: 'missing' };
              }
              if (
                left.version !== leftInput.expectedVersion ||
                right.version !== rightInput.expectedVersion
              ) {
                return { status: 'conflict', current };
              }
              const eligible =
                left.claimType === right.claimType &&
                left.status !== 'rejected' &&
                right.status !== 'rejected' &&
                left.supersededByClaimId === null &&
                right.supersededByClaimId === null;
              if (!eligible) {
                return { status: 'not_eligible', current };
              }

              const updatedAt = new Date();
              await transaction
                .insert(claimPairDecisions)
                .values({
                  candidateId: input.candidateId,
                  leftClaimId: left.claimId,
                  rightClaimId: right.claimId,
                  leftVersion: left.version,
                  rightVersion: right.version,
                  decision: 'different',
                  updatedAt
                })
                .onConflictDoUpdate({
                  target: [
                    claimPairDecisions.candidateId,
                    claimPairDecisions.leftClaimId,
                    claimPairDecisions.rightClaimId
                  ],
                  set: {
                    leftVersion: left.version,
                    rightVersion: right.version,
                    decision: 'different',
                    updatedAt
                  }
                });
              return { status: 'saved' };
            }
          )
        )
      );
    },

    async listClaimPairDecisions(candidateId) {
      return withDbErrors('Claim pair decisions', () =>
        database.db
          .select()
          .from(claimPairDecisions)
          .where(eq(claimPairDecisions.candidateId, candidateId))
          .orderBy(
            asc(claimPairDecisions.leftClaimId),
            asc(claimPairDecisions.rightClaimId)
          )
      );
    },

    async deletePendingExtractedClaims(
      candidateId,
      documentId,
      transaction
    ) {
      return withDbErrors('Claims', async () => {
        const deleted = await transaction
          .delete(claims)
          .where(
            and(
              eq(claims.candidateId, candidateId),
              eq(claims.origin, 'extracted'),
              eq(claims.status, 'pending'),
              eq(claims.extractionDocumentId, documentId),
              // A pending claim the candidate edited holds their decision and
              // is kept; the new extraction matches it like any active claim.
              isNull(claims.candidateEditedAt)
            )
          )
          .returning({ claimId: claims.claimId });

        return deleted.length;
      });
    },

    async listReviewedExtractedClaims(
      candidateId,
      documentId,
      transaction
    ) {
      return withDbErrors('Claims', () =>
        selectClaims(
          transaction,
          and(
            eq(claims.candidateId, candidateId),
            eq(claims.origin, 'extracted'),
            inArray(claims.status, ['accepted', 'rejected']),
            eq(claims.extractionDocumentId, documentId)
          )
        )
      );
    },

    async reviewExtractedClaim(
      candidateId,
      claimId,
      status,
      expectedVersion
    ) {
      return withDbErrors('Claim', async (): Promise<ReviewClaimResult> => {
        const [reviewed] = await database.db
          .update(claims)
          .set({ status, version: sql`${claims.version} + 1` })
          .where(
            and(
              eq(claims.candidateId, candidateId),
              eq(claims.claimId, claimId),
              eq(claims.origin, 'extracted'),
              eq(claims.status, 'pending'),
              // A merged duplicate is hidden evidence, not a reviewable claim.
              isNull(claims.supersededByClaimId),
              expectedVersion === undefined
                ? undefined
                : eq(claims.version, expectedVersion)
            )
          )
          .returning({ claimId: claims.claimId });

        if (reviewed) {
          const [record] = await selectClaims(
            database.db,
            and(
              eq(claims.candidateId, candidateId),
              eq(claims.claimId, claimId)
            )
          );
          if (!record) {
            throw new Error('Reviewed claim could not be read');
          }
          return { status: 'saved', record };
        }

        const [current] = await selectClaims(
          database.db,
          and(
            eq(claims.candidateId, candidateId),
            eq(claims.claimId, claimId)
          )
        );
        if (!current) {
          return { status: 'missing' };
        }
        if (
          expectedVersion !== undefined &&
          current.version !== expectedVersion
        ) {
          return { status: 'conflict', current };
        }
        return { status: 'not_reviewable', current };
      });
    },

    async listClaims(candidateId, filters = {}, transaction = database.db) {
      return withDbErrors('Claims', () =>
        selectClaims(
          transaction,
          and(
            eq(claims.candidateId, candidateId),
            isNull(claims.supersededByClaimId),
            filters.claimType ? eq(claims.claimType, filters.claimType) : undefined,
            filters.status
              ? Array.isArray(filters.status)
                ? inArray(claims.status, filters.status)
                : eq(claims.status, filters.status)
              : undefined
          )
        )
      );
    },

    async listClaimSourceOccurrences(candidateId, claimIds) {
      if (claimIds.length === 0) {
        return [];
      }

      return withDbErrors('Claim source occurrences', async () => {
        const rows = await database.db
          .select({ occurrence: sourceOccurrences })
          .from(sourceOccurrences)
          .innerJoin(claims, eq(claims.claimId, sourceOccurrences.claimId))
          .where(
            and(
              eq(claims.candidateId, candidateId),
              inArray(claims.status, ['accepted', 'auto_accepted']),
              isNull(claims.supersededByClaimId),
              inArray(claims.claimId, claimIds)
            )
          )
          .orderBy(asc(sourceOccurrences.claimId), asc(sourceOccurrences.anchorKey));

        return rows.map(({ occurrence }) => occurrence);
      });
    },

    async findClaim(candidateId, claimId) {
      return withDbErrors('Claim', async () => {
        const [claim] = await selectClaims(
          database.db,
          and(eq(claims.claimId, claimId), eq(claims.candidateId, candidateId))
        );
        return claim ?? null;
      });
    },

    // The claim row is locked first, so concurrent edits run one after the
    // other: each archives the values it actually replaces, and an edit based
    // on an older version is refused.
    async updateClaimValues(input) {
      return withTransientRetry(() => withDbErrors('Claim', () => {
        return database.db.transaction(
          async (transaction): Promise<VersionedWrite<ClaimRecord>> => {
            const ownedClaim = and(
              eq(claims.claimId, input.claimId),
              eq(claims.candidateId, input.candidateId)
            );
            // Locked on its own: PostgreSQL cannot lock rows through the outer
            // joins that read the claim's details.
            const [locked] = await transaction
              .select({ claimId: claims.claimId })
              .from(claims)
              .where(ownedClaim)
              .for('update');
            const [current] = locked
              ? await selectClaims(transaction, ownedClaim)
              : [];
            if (!current) {
              return { status: 'missing' };
            }
            if (
              input.expectedVersion !== undefined &&
              current.version !== input.expectedVersion
            ) {
              return { status: 'conflict', current };
            }

            await transaction
              .insert(claimRevisions)
              .values({
                claimId: current.claimId,
                previousValues: current.values,
                previousCurrent: current.current
              });
            await updateDetails(
              transaction,
              current.claimId,
              current.claimType,
              input.values
            );
            // Editing the result of an automatic merge approves it: its notices
            // are acknowledged and it becomes accepted, so a later "keep
            // separate" cannot restore pre-merge values over this edit.
            const approvesAutoMerge = current.status === 'auto_accepted';
            const updatedAt = new Date();
            await transaction
              .update(claims)
              .set({
                updatedAt,
                version: sql`${claims.version} + 1`,
                ...(current.origin === 'extracted'
                  ? { candidateEditedAt: updatedAt }
                  : {}),
                ...(approvesAutoMerge ? { status: 'accepted' as const } : {})
              })
              .where(ownedClaim);
            if (approvesAutoMerge) {
              await transaction
                .update(claimAutoMergeNotices)
                .set({
                  status: 'acknowledged',
                  acknowledgedAt: updatedAt,
                  updatedAt
                })
                .where(
                  and(
                    eq(claimAutoMergeNotices.candidateId, input.candidateId),
                    eq(claimAutoMergeNotices.survivorClaimId, current.claimId),
                    eq(claimAutoMergeNotices.status, 'pending')
                  )
                );
            }

            const [updated] = await selectClaims(transaction, ownedClaim);
            if (!updated) {
              throw new Error('Updated claim could not be read');
            }
            return { status: 'saved', record: updated };
          }
        );
      }));
    },

    async setClaimStatus(candidateId, claimId, status, expectedVersion) {
      return withDbErrors('Claim', () =>
        database.db.transaction(async (transaction) => {
          const ownedClaim = and(
            eq(claims.claimId, claimId),
            eq(claims.candidateId, candidateId)
          );
          const [locked] = await transaction
            .select({ claimId: claims.claimId })
            .from(claims)
            .where(ownedClaim)
            .for('update');
          const [current] = locked
            ? await selectClaims(transaction, ownedClaim)
            : [];
          if (!current) {
            return null;
          }
          if (current.version !== expectedVersion) {
            return null;
          }
          await transaction
            .update(claims)
            .set({
              status,
              updatedAt: new Date(),
              version: sql`${claims.version} + 1`
            })
            .where(ownedClaim);
          const [updated] = await selectClaims(transaction, ownedClaim);
          if (!updated) {
            throw new Error('Updated claim could not be read');
          }
          return updated;
        })
      );
    },

    async deleteClaim(candidateId, claimId, expectedVersion) {
      return withDbErrors('Claim', async (): Promise<VersionedDelete<ClaimRecord>> => {
        const ownedClaim = and(
          eq(claims.claimId, claimId),
          eq(claims.candidateId, candidateId)
        );
        const deleted = await database.db
          .delete(claims)
          .where(
            and(
              ownedClaim,
              expectedVersion === undefined
                ? undefined
                : eq(claims.version, expectedVersion)
            )
          )
          .returning({ claimId: claims.claimId });

        if (deleted.length > 0) {
          return { status: 'deleted' };
        }

        const [current] = await selectClaims(database.db, ownedClaim);
        return current ? { status: 'conflict', current } : { status: 'missing' };
      });
    }
  };
}
