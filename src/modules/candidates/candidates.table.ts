import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { documents } from '../documents/documents.table.js';
import { users } from '../users/users.table.js';

export interface ProfileLink {
  label: string;
  url: string;
}

export type ClaimFieldValue = string | string[];
export type ClaimSnapshot = Record<string, ClaimFieldValue>;
export interface ClaimExtractionMetadata {
  invocationId: string;
  // Legacy extracted rows predate document provenance and read as null.
  sourceDocumentId: string | null;
  rawValues: Record<string, string>;
  fieldSources: Record<string, string[]>;
  current: boolean;
}

export interface NewClaimExtractionMetadata
  extends Omit<ClaimExtractionMetadata, 'sourceDocumentId'> {
  sourceDocumentId: string;
}

export type ClaimSourceAnchor =
  | {
    kind: 'pdf_line';
    order: number;
    pageNumber: number;
    box: { x: number; y: number; width: number; height: number };
    text: string;
    links: string[];
  }
  | {
    kind: 'docx_paragraph';
    blockIndex: number;
    text: string;
    links: string[];
  }
  | {
    kind: 'docx_table_row';
    blockIndex: number;
    rowNumber: number;
    cells: string[];
  };

export interface AutoMergeClaimSourceSnapshot {
  documentId: string;
  anchorKey: string;
  sourceReferences: string[];
  fieldNames: string[];
  anchor: ClaimSourceAnchor;
}

export interface AutoMergeClaimSnapshot {
  claimId: string;
  claimType: (typeof claimType.enumValues)[number];
  origin: (typeof claimOrigin.enumValues)[number];
  status: (typeof claimStatus.enumValues)[number];
  current: boolean;
  values: ClaimSnapshot;
  version: number;
  sourceDocumentId: string | null;
  sources: AutoMergeClaimSourceSnapshot[];
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
  // Published like `accepted`, but produced or updated by an automatic
  // duplicate merge and still awaiting the candidate's acknowledgment. On
  // acknowledge it flips to `accepted`. Profile export treats it like
  // `accepted`.
  'auto_accepted',
  'rejected'
]);

export const claimAutoMergeNoticeStatus = pgEnum(
  'claim_auto_merge_notice_status',
  ['pending', 'acknowledged', 'reverted']
);

export const claimDatePrecision = pgEnum('claim_date_precision', [
  'year',
  'month'
]);
export type ClaimDatePrecision = (typeof claimDatePrecision.enumValues)[number];

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
    current: boolean('current').default(false).notNull(),
    // Candidate authority is separate from origin so edited extraction keeps
    // its original evidence while outranking untouched extraction.
    candidateEditedAt: timestamp('candidate_edited_at', {
      withTimezone: true,
      mode: 'date'
    }),
    // A merged duplicate is hidden evidence of its survivor: deleting the
    // survivor deletes the claims it absorbed, through any chain of merges.
    supersededByClaimId: uuid('superseded_by_claim_id').references(
      (): AnyPgColumn => claims.claimId,
      { onDelete: 'cascade' }
    ),
    // Original AI evidence stays separate from the reviewed claim values.
    extractionInvocationId: uuid('extraction_invocation_id'),
    extractionDocumentId: uuid('extraction_document_id'),
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
    index('claims_superseded_by_claim_id_idx').on(table.supersededByClaimId),
    check(
      'claims_not_self_superseded',
      sql`${table.supersededByClaimId} is null or ${table.supersededByClaimId} <> ${table.claimId}`
    ),
    check(
      'claims_extraction_metadata_matches_origin',
      sql`(
        ${table.origin} = 'manual'
        and ${table.extractionInvocationId} is null
        and ${table.extractionDocumentId} is null
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

// One row per automatic duplicate-merge event on the surviving claim. Holds
// human-readable messages, the ids of the superseded duplicate claims, and the
// acknowledgment lifecycle so the candidate can review what the system merged.
export const claimAutoMergeNotices = pgTable(
  'claim_auto_merge_notices',
  {
    noticeId: uuid('notice_id').primaryKey().defaultRandom().notNull(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.candidateId, { onDelete: 'cascade' }),
    survivorClaimId: uuid('survivor_claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    // The claim(s) retired by this auto-merge; never empty so every notice
    // documents at least one duplicate.
    supersededClaimIds: uuid('superseded_claim_ids').array().notNull(),
    // Short, human-readable copy derived from the compared field differences.
    messages: text('messages').array().notNull(),
    // Exact pre-merge values and physical evidence make the automatic action
    // explainable and safely reversible. Null is retained for legacy notices.
    claimsBefore: jsonb('claims_before').$type<AutoMergeClaimSnapshot[]>(),
    status: claimAutoMergeNoticeStatus('status')
      .default('pending')
      .notNull(),
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
      .notNull(),
    acknowledgedAt: timestamp('acknowledged_at', {
      withTimezone: true,
      mode: 'date'
    })
  },
  (table) => [
    index('claim_auto_merge_notices_survivor_status_idx').on(
      table.survivorClaimId,
      table.status
    ),
    index('claim_auto_merge_notices_candidate_id_idx').on(table.candidateId),
    check(
      'claim_auto_merge_notices_superseded_not_empty',
      sql`cardinality(${table.supersededClaimIds}) > 0`
    ),
    check(
      'claim_auto_merge_notices_messages_not_empty',
      sql`cardinality(${table.messages}) > 0`
    )
  ]
);

export const claimPairDecisions = pgTable(
  'claim_pair_decisions',
  {
    decisionId: uuid('decision_id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.candidateId, { onDelete: 'cascade' }),
    leftClaimId: uuid('left_claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    rightClaimId: uuid('right_claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    leftVersion: integer('left_version').notNull(),
    rightVersion: integer('right_version').notNull(),
    decision: text('decision').$type<'different'>().default('different').notNull(),
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
    uniqueIndex('claim_pair_decisions_candidate_pair_unique').on(
      table.candidateId,
      table.leftClaimId,
      table.rightClaimId
    ),
    index('claim_pair_decisions_left_claim_id_idx').on(table.leftClaimId),
    index('claim_pair_decisions_right_claim_id_idx').on(table.rightClaimId),
    check(
      'claim_pair_decisions_claims_ordered',
      sql`${table.leftClaimId} < ${table.rightClaimId}`
    ),
    check(
      'claim_pair_decisions_versions_positive',
      sql`${table.leftVersion} > 0 and ${table.rightVersion} > 0`
    ),
    check(
      'claim_pair_decisions_decision_valid',
      sql`${table.decision} = 'different'`
    )
  ]
);

// Physical document evidence only. Parser-inferred headings, sections, and
// semantic-support decisions do not belong in this table.
export const sourceOccurrences = pgTable(
  'source_occurrences',
  {
    occurrenceId: uuid('occurrence_id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.documentId, { onDelete: 'cascade' }),
    anchorKey: text('anchor_key').notNull(),
    sourceReferences: text('source_references').array().notNull(),
    fieldNames: text('field_names').array().notNull(),
    anchor: jsonb('anchor').$type<ClaimSourceAnchor>().notNull()
  },
  (table) => [
    uniqueIndex('source_occurrences_claim_document_anchor_unique').on(
      table.claimId,
      table.documentId,
      table.anchorKey
    ),
    index('source_occurrences_document_id_idx').on(table.documentId),
    check(
      'source_occurrences_anchor_key_not_blank',
      sql`length(btrim(${table.anchorKey})) > 0`
    ),
    check(
      'source_occurrences_references_not_empty',
      sql`cardinality(${table.sourceReferences}) > 0`
    ),
    check(
      'source_occurrences_fields_not_empty',
      sql`cardinality(${table.fieldNames}) > 0`
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
    startDatePrecision: claimDatePrecision('start_date_precision')
      .default('month')
      .notNull(),
    endDate: date('end_date', { mode: 'string' }),
    endDatePrecision: claimDatePrecision('end_date_precision'),
    location: text('location'),
    description: text('description'),
    skills: text('skills').array().default(sql`'{}'::text[]`).notNull()
  },
  (table) => [
    index('employment_details_skills_idx').using('gin', table.skills),
    check(
      'employment_details_dates_ordered',
      sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`
    ),
    check(
      'employment_details_end_precision_matches_date',
      sql`(${table.endDate} is null) = (${table.endDatePrecision} is null)`
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
    startDatePrecision: claimDatePrecision('start_date_precision')
      .default('month')
      .notNull(),
    endDate: date('end_date', { mode: 'string' }),
    endDatePrecision: claimDatePrecision('end_date_precision')
  },
  (table) => [
    check(
      'education_details_dates_ordered',
      sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`
    ),
    check(
      'education_details_end_precision_matches_date',
      sql`(${table.endDate} is null) = (${table.endDatePrecision} is null)`
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
    issueDatePrecision: claimDatePrecision('issue_date_precision')
      .default('month')
      .notNull(),
    expiryDate: date('expiry_date', { mode: 'string' }),
    expiryDatePrecision: claimDatePrecision('expiry_date_precision'),
    credentialId: text('credential_id')
  },
  (table) => [
    check(
      'certification_details_dates_ordered',
      sql`${table.expiryDate} is null or ${table.expiryDate} >= ${table.issueDate}`
    ),
    check(
      'certification_details_expiry_precision_matches_date',
      sql`(${table.expiryDate} is null) = (${table.expiryDatePrecision} is null)`
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
    startDatePrecision: claimDatePrecision('start_date_precision'),
    endDate: date('end_date', { mode: 'string' }),
    endDatePrecision: claimDatePrecision('end_date_precision'),
    skills: text('skills').array().default(sql`'{}'::text[]`).notNull()
  },
  (table) => [
    index('project_details_skills_idx').using('gin', table.skills),
    check(
      'project_details_dates_ordered',
      sql`${table.startDate} is null or ${table.endDate} is null
        or ${table.endDate} >= ${table.startDate}`
    ),
    check(
      'project_details_start_precision_matches_date',
      sql`(${table.startDate} is null) = (${table.startDatePrecision} is null)`
    ),
    check(
      'project_details_end_precision_matches_date',
      sql`(${table.endDate} is null) = (${table.endDatePrecision} is null)`
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
    // Null only for legacy revisions created before current/Present state was
    // archived independently from extraction evidence.
    previousCurrent: boolean('previous_current'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull()
  },
  (table) => [index('claim_revisions_claim_id_idx').on(table.claimId)]
);

export type ClaimAutoMergeNoticeRecord = typeof claimAutoMergeNotices.$inferSelect;
export type NewClaimAutoMergeNotice = typeof claimAutoMergeNotices.$inferInsert;
