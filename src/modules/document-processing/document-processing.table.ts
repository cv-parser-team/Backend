import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { documents } from '../documents/documents.table.js';

export const processingJobStatus = pgEnum('processing_job_status', [
  'queued',
  'processing',
  'retrying',
  'completed',
  'failed'
]);

export type ProcessingJobStatus =
  (typeof processingJobStatus.enumValues)[number];

// A job in one of these statuses will still run; a document has at most one.
// The statuses are written as literals, because the conflict target of an
// insert must repeat the partial index's condition exactly.
export function isActiveJob(status: AnyPgColumn): SQL {
  return sql`${status} in ('queued', 'processing', 'retrying')`;
}

export const documentProcessingJobs = pgTable(
  'document_processing_jobs',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.documentId, { onDelete: 'cascade' }),
    status: processingJobStatus('status').default('queued').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    failureCode: text('failure_code'),
    availableAt: timestamp('available_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull(),
    lockedUntil: timestamp('locked_until', {
      withTimezone: true,
      mode: 'date'
    }),
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
    index('document_processing_jobs_runnable_idx').on(
      table.status,
      table.availableAt
    ),
    index('document_processing_jobs_lease_idx').on(
      table.status,
      table.lockedUntil
    ),
    index('document_processing_jobs_document_id_idx').on(table.documentId),
    uniqueIndex('document_processing_jobs_active_document_unique')
      .on(table.documentId)
      .where(isActiveJob(table.status)),
    check(
      'document_processing_jobs_attempt_count_nonnegative',
      sql`${table.attemptCount} >= 0`
    )
  ]
);
