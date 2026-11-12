import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { users } from '../users/users.table.js';

export interface ProfileLink {
  label: string;
  url: string;
}

export type ClaimFieldValue = string | string[];
export type ClaimSnapshot = Record<string, ClaimFieldValue>;
export interface ClaimExtractionMetadata {
  invocationId: string;
  rawValues: Record<string, string>;
  fieldSources: Record<string, string[]>;
  current: boolean;
}

export const claimType = pgEnum('claim_type', [
  'skill',
  'employment',
  'education',
  'certification',
  'language',
  'project'
]);

export const claimOrigin = pgEnum('claim_origin', ['manual', 'extracted']);

export const claimStatus = pgEnum('claim_status', [
  'pending',
  'accepted',
  'rejected'
]);

export const candidates = pgTable(
  'candidates',
  {
    candidateId: uuid('candidate_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    headline: text('headline'),
    summary: text('summary'),
    phone: text('phone'),
    location: text('location'),
    // The email shown on the CV, which can differ from the account email.
    contactEmail: text('contact_email'),
    profileLinks: jsonb('profile_links')
      .$type<ProfileLink[]>()
      .default([])
      .notNull(),
    // Increases on every change, so an edit based on an older version can be
    // refused instead of silently overwriting the newer one.
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex('candidates_user_id_unique').on(table.userId),
    check(
      'candidates_full_name_not_blank',
      sql`length(btrim(${table.fullName})) > 0`
    )
  ]
);

export const claims = pgTable(
  'claims',
  {
    claimId: uuid('claim_id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.candidateId, { onDelete: 'cascade' }),
    claimType: claimType('claim_type').notNull(),
    origin: claimOrigin('origin').notNull(),
    status: claimStatus('status').default('pending').notNull(),
    // Original AI evidence stays separate from the reviewed claim values.
    extractionInvocationId: uuid('extraction_invocation_id'),
    extractionRawValues: jsonb('extraction_raw_values').$type<Record<string, string>>(),
    extractionFieldSources: jsonb('extraction_field_sources').$type<
      Record<string, string[]>
    >(),
    extractionCurrent: boolean('extraction_current'),
    // Increases on every change of the claim's values.
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    index('claims_candidate_id_idx').on(table.candidateId),
    check(
      'claims_extraction_metadata_matches_origin',
      sql`(
        ${table.origin} = 'manual'
        and ${table.extractionInvocationId} is null
        and ${table.extractionRawValues} is null
        and ${table.extractionFieldSources} is null
        and ${table.extractionCurrent} is null
      ) or (
        ${table.origin} = 'extracted'
        and ${table.extractionInvocationId} is not null
        and ${table.extractionRawValues} is not null
        and ${table.extractionFieldSources} is not null
        and ${table.extractionCurrent} is not null
      )`
    )
  ]
);

// Each claim has exactly one details row, in the table that matches its type.
function detailsClaimId() {
  return uuid('claim_id')
    .primaryKey()
    .references(() => claims.claimId, { onDelete: 'cascade' });
}

export const skillDetails = pgTable(
  'skill_details',
  {
    claimId: detailsClaimId(),
    name: text('name').notNull()
  },
  (table) => [
    index('skill_details_name_lower_idx').on(sql`lower(${table.name})`)
  ]
);

export const employmentDetails = pgTable(
  'employment_details',
  {
    claimId: detailsClaimId(),
    employer: text('employer').notNull(),
    jobTitle: text('job_title').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    location: text('location'),
    description: text('description'),
    skills: text('skills').array().default(sql`'{}'::text[]`).notNull()
  },
  (table) => [
    index('employment_details_skills_idx').using('gin', table.skills),
    check(
      'employment_details_dates_ordered',
      sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`
    )
  ]
);

export const educationDetails = pgTable(
  'education_details',
  {
    claimId: detailsClaimId(),
    institution: text('institution').notNull(),
    degree: text('degree').notNull(),
    fieldOfStudy: text('field_of_study'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' })
  },
  (table) => [
    check(
      'education_details_dates_ordered',
      sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`
    )
  ]
);

export const certificationDetails = pgTable(
  'certification_details',
  {
    claimId: detailsClaimId(),
    title: text('title').notNull(),
    issuer: text('issuer').notNull(),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    expiryDate: date('expiry_date', { mode: 'string' }),
    credentialId: text('credential_id')
  },
  (table) => [
    check(
      'certification_details_dates_ordered',
      sql`${table.expiryDate} is null or ${table.expiryDate} >= ${table.issueDate}`
    )
  ]
);

// Proficiency is kept as the candidate or CV writes it, such as "Native" or
// "C1"; mapping it to one scale belongs to normalization.
export const languageDetails = pgTable('language_details', {
  claimId: detailsClaimId(),
  name: text('name').notNull(),
  proficiency: text('proficiency')
});

// Many CVs list projects without dates, so both dates are optional.
export const projectDetails = pgTable(
  'project_details',
  {
    claimId: detailsClaimId(),
    name: text('name').notNull(),
    description: text('description'),
    role: text('role'),
    url: text('url'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    skills: text('skills').array().default(sql`'{}'::text[]`).notNull()
  },
  (table) => [
    index('project_details_skills_idx').using('gin', table.skills),
    check(
      'project_details_dates_ordered',
      sql`${table.startDate} is null or ${table.endDate} is null
        or ${table.endDate} >= ${table.startDate}`
    )
  ]
);

// Before a claim is edited, its previous values are archived here, so the
// first revision of an edited claim holds its original values.
export const claimRevisions = pgTable(
  'claim_revisions',
  {
    revisionId: uuid('revision_id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    previousValues: jsonb('previous_values').$type<ClaimSnapshot>().notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull()
  },
  (table) => [index('claim_revisions_claim_id_idx').on(table.claimId)]
);
