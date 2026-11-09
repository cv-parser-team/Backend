import { and, asc, eq, SQL } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import {
  candidates,
  certificationDetails,
  ClaimFieldValue,
  claimRevisions,
  claims,
  ClaimSnapshot,
  educationDetails,
  employmentDetails,
  languageDetails,
  projectDetails,
  skillDetails
} from './candidates.table.js';

export type CandidateRecord = typeof candidates.$inferSelect;
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

export interface ClaimRecord {
  claimId: string;
  claimType: ClaimRow['claimType'];
  origin: ClaimRow['origin'];
  status: ClaimRow['status'];
  values: ClaimValues;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateClaimInput {
  candidateId: string;
  claimType: ClaimRow['claimType'];
  origin: ClaimRow['origin'];
  status: ClaimRow['status'];
  values: ClaimValues;
}

export interface ClaimFilters {
  claimType?: ClaimRow['claimType'];
  status?: ClaimRow['status'];
}

export interface UpdateClaimValuesInput {
  candidateId: string;
  claimId: string;
  values: ClaimValues;
}

export interface CandidatesRepository {
  findCandidateByUserId(userId: string): Promise<CandidateRecord | null>;
  createCandidate(input: CreateCandidateInput): Promise<CandidateRecord>;
  updateCandidate(
    candidateId: string,
    input: UpdateCandidateInput
  ): Promise<CandidateRecord>;
  createClaim(input: CreateClaimInput): Promise<ClaimRecord>;
  listClaims(candidateId: string, filters?: ClaimFilters): Promise<ClaimRecord[]>;
  findClaim(candidateId: string, claimId: string): Promise<ClaimRecord | null>;
  updateClaimValues(input: UpdateClaimValuesInput): Promise<ClaimRecord | null>;
  deleteClaim(candidateId: string, claimId: string): Promise<boolean>;
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

// The API uses YYYY-MM; the database stores the first day of that month.
function toDate(month: string): string;
function toDate(month: string | null): string | null;
function toDate(month: string | null): string | null {
  return month === null ? null : `${month}-01`;
}

function toMonth(date: string | null): string | null {
  return date === null ? null : date.slice(0, 7);
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
  return {
    employer: readRequiredText(values, 'employer'),
    jobTitle: readRequiredText(values, 'jobTitle'),
    startDate: toDate(readRequiredText(values, 'startDate')),
    endDate: toDate(readText(values, 'endDate')),
    location: readText(values, 'location'),
    description: readText(values, 'description'),
    skills: readList(values, 'skills')
  };
}

function toEducationRow(values: ClaimValues) {
  return {
    institution: readRequiredText(values, 'institution'),
    degree: readRequiredText(values, 'degree'),
    fieldOfStudy: readText(values, 'fieldOfStudy'),
    startDate: toDate(readRequiredText(values, 'startDate')),
    endDate: toDate(readText(values, 'endDate'))
  };
}

function toCertificationRow(values: ClaimValues) {
  return {
    title: readRequiredText(values, 'title'),
    issuer: readRequiredText(values, 'issuer'),
    issueDate: toDate(readRequiredText(values, 'issueDate')),
    expiryDate: toDate(readText(values, 'expiryDate')),
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
  return {
    name: readRequiredText(values, 'name'),
    description: readText(values, 'description'),
    role: readText(values, 'role'),
    url: readText(values, 'url'),
    startDate: toDate(readText(values, 'startDate')),
    endDate: toDate(readText(values, 'endDate')),
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
        startDate: toMonth(employment.startDate),
        endDate: toMonth(employment.endDate),
        location: employment.location,
        description: employment.description,
        skills: employment.skills
      });
    } else if (claim.claimType === 'education' && education) {
      values = compactValues({
        institution: education.institution,
        degree: education.degree,
        fieldOfStudy: education.fieldOfStudy,
        startDate: toMonth(education.startDate),
        endDate: toMonth(education.endDate)
      });
    } else if (claim.claimType === 'certification' && certification) {
      values = compactValues({
        title: certification.title,
        issuer: certification.issuer,
        issueDate: toMonth(certification.issueDate),
        expiryDate: toMonth(certification.expiryDate),
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
        startDate: toMonth(project.startDate),
        endDate: toMonth(project.endDate),
        skills: project.skills
      });
    }

    return {
      claimId: claim.claimId,
      claimType: claim.claimType,
      origin: claim.origin,
      status: claim.status,
      values,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt
    };
  });
}

export function createCandidatesRepository(
  database: AppDatabase
): CandidatesRepository {
  return {
    async findCandidateByUserId(userId) {
      return withDbErrors('Candidate', async () => {
        const [candidate] = await database.db
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

    async updateCandidate(candidateId, input) {
      return withDbErrors('Candidate', async () => {
        const [updatedCandidate] = await database.db
          .update(candidates)
          .set(input)
          .where(eq(candidates.candidateId, candidateId))
          .returning();

        if (!updatedCandidate) {
          throw new RecordNotFoundError('Candidate', candidateId);
        }

        return updatedCandidate;
      });
    },

    async createClaim(input) {
      return withDbErrors('Claim', () => {
        return database.db.transaction(async (transaction) => {
          const [createdClaim] = await transaction
            .insert(claims)
            .values({
              candidateId: input.candidateId,
              claimType: input.claimType,
              origin: input.origin,
              status: input.status
            })
            .returning({ claimId: claims.claimId });

          if (!createdClaim) {
            throw new Error('Claim creation did not return a record');
          }

          await insertDetails(
            transaction,
            createdClaim.claimId,
            input.claimType,
            input.values
          );

          const [claim] = await selectClaims(
            transaction,
            eq(claims.claimId, createdClaim.claimId)
          );
          if (!claim) {
            throw new Error('Created claim could not be read');
          }
          return claim;
        });
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

    async findClaim(candidateId, claimId) {
      return withDbErrors('Claim', async () => {
        const [claim] = await selectClaims(
          database.db,
          and(eq(claims.claimId, claimId), eq(claims.candidateId, candidateId))
        );
        return claim ?? null;
      });
    },

    async updateClaimValues(input) {
      return withDbErrors('Claim', () => {
        return database.db.transaction(async (transaction) => {
          const ownedClaim = and(
            eq(claims.claimId, input.claimId),
            eq(claims.candidateId, input.candidateId)
          );
          const [current] = await selectClaims(transaction, ownedClaim);
          if (!current) {
            return null;
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
            .set({ updatedAt: new Date() })
            .where(ownedClaim);

          const [updated] = await selectClaims(transaction, ownedClaim);
          return updated ?? null;
        });
      });
    },

    async deleteClaim(candidateId, claimId) {
      return withDbErrors('Claim', async () => {
        const deleted = await database.db
          .delete(claims)
          .where(
            and(eq(claims.claimId, claimId), eq(claims.candidateId, candidateId))
          )
          .returning({ claimId: claims.claimId });

        return deleted.length > 0;
      });
    }
  };
}
