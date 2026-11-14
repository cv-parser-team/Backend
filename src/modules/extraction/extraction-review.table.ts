import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid
} from 'drizzle-orm/pg-core';
import { documents } from '../documents/documents.table.js';
import type {
  ExtractionReviewIssue
} from './extraction.mapper.js';
import type { ClaimType } from './extraction.schemas.js';

export const extractionReviewStatus = pgEnum('extraction_review_status', [
  'pending',
  'resolved',
  'dismissed'
]);

export const extractionReviewItems = pgTable(
  'extraction_review_items',
  {
    reviewItemId: uuid('review_item_id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.documentId, { onDelete: 'cascade' }),
    extractionInvocationId: uuid('extraction_invocation_id').notNull(),
    claimType: text('claim_type').$type<ClaimType>().notNull(),
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull(),
    issues: jsonb('issues').$type<ExtractionReviewIssue[]>().notNull(),
    sources: text('sources').array().notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: extractionReviewStatus('status').default('pending').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    index('extraction_review_items_document_status_idx').on(
      table.documentId,
      table.status
    ),
    check(
      'extraction_review_items_claim_type_valid',
      sql`${table.claimType} in ('skill', 'employment', 'education', 'certification', 'language', 'project')`
    ),
    check(
      'extraction_review_items_issues_not_empty',
      sql`jsonb_array_length(${table.issues}) > 0`
    ),
    check(
      'extraction_review_items_fingerprint_not_blank',
      sql`length(btrim(${table.fingerprint})) > 0`
    )
  ]
);
