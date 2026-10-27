import { sql } from 'drizzle-orm';
import {
  check,
  index,
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

export const claimType = pgEnum('claim_type', [
  'skill',
  'employment',
  'education',
  'certification'
]);

export const claimOrigin = pgEnum('claim_origin', ['manual', 'extracted']);

export const claimStatus = pgEnum('claim_status', [
  'pending',
  'accepted',
  'rejected'
]);

export const claimValueStatus = pgEnum('claim_value_status', [
  'current',
  'superseded'
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
    profileLinks: jsonb('profile_links')
      .$type<ProfileLink[]>()
      .default([])
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
  (table) => [index('claims_candidate_id_idx').on(table.candidateId)]
);

// Each row stores one field of a claim. Edits supersede the current row
// instead of overwriting it, preserving the original value.
export const claimValueHistory = pgTable(
  'claim_value_history',
  {
    valueId: uuid('value_id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    fieldName: text('field_name').notNull(),
    value: jsonb('value').$type<ClaimFieldValue>().notNull(),
    valueStatus: claimValueStatus('value_status').default('current').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index('claim_value_history_claim_id_idx').on(table.claimId),
    uniqueIndex('claim_value_history_current_field_unique')
      .on(table.claimId, table.fieldName)
      .where(sql`${table.valueStatus} = 'current'`),
    check(
      'claim_value_history_field_name_not_blank',
      sql`length(btrim(${table.fieldName})) > 0`
    )
  ]
);
