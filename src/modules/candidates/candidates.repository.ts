import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql, SQL } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { withTransientRetry } from '../../infrastructure/database/transient-retry.js';
import type { DatabaseExecutor } from '../../infrastructure/database/unit-of-work.js';
import {
  candidates,
  certificationDetails,
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

export interface ClaimRecord {
  claimId: string;
  claimType: ClaimRow['claimType'];
  origin: ClaimRow['origin'];
  status: ClaimRow['status'];
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
  status?: ClaimRow['status'];
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
  listClaims(candidateId: string, filters?: ClaimFilters): Promise<ClaimRecord[]>;
  listClaimSourceOccurrences(
    candidateId: string,
    claimIds: string[]
  ): Promise<ClaimSourceOccurrenceRecord[]>;
  findClaim(candidateId: string, claimId: string): Promise<ClaimRecord | null>;
  updateClaimValues(input: UpdateClaimValuesInput): Promise<VersionedWrite<ClaimRecord>>;
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
      claimType: claim.claimType,
      origin: claim.origin,
      status: claim.status,
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
      return withDbErrors('Claim source occurrences', async () => {
        await transaction.insert(sourceOccurrences).values(inputs);
        return inputs.length;
      });
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
              eq(claims.extractionDocumentId, documentId)
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

    async listClaims(candidateId, filters = {}) {
      return withDbErrors('Claims', () =>
        selectClaims(
          database.db,
          and(
            eq(claims.candidateId, candidateId),
            filters.claimType ? eq(claims.claimType, filters.claimType) : undefined,
            filters.status ? eq(claims.status, filters.status) : undefined
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
              eq(claims.status, 'accepted'),
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
              .values({ claimId: current.claimId, previousValues: current.values });
            await updateDetails(
              transaction,
              current.claimId,
              current.claimType,
              input.values
            );
            await transaction
              .update(claims)
              .set({ updatedAt: new Date(), version: sql`${claims.version} + 1` })
              .where(ownedClaim);

            const [updated] = await selectClaims(transaction, ownedClaim);
            if (!updated) {
              throw new Error('Updated claim could not be read');
            }
            return { status: 'saved', record: updated };
          }
        );
      }));
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
