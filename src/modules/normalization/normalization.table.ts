import { sql, type SQL } from 'drizzle-orm';
import {
  AnyPgColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { claims } from '../candidates/candidates.table.js';

// Values that V1 does not use yet are defined now, so later matching steps,
// such as fuzzy or AI matching, add behavior without changing enumerations.
export const canonicalCategory = pgEnum('canonical_category', ['skill', 'job_title', 'degree']);

export const canonicalStatus = pgEnum('canonical_status', ['active', 'merged']);

export const aliasScope = pgEnum('alias_scope', ['global', 'candidate']);

export const aliasOrigin = pgEnum('alias_origin', ['seed', 'ai', 'candidate', 'reviewer']);

export const aliasStatus = pgEnum('alias_status', ['pending', 'approved', 'rejected']);

export const normalizationMethod = pgEnum('normalization_method', [
  'canonical',
  'alias',
  'fuzzy',
  'ai',
  'candidate'
]);

export const normalizationStatus = pgEnum('normalization_status', [
  'matched',
  'unmatched',
  'ambiguous'
]);

export const actorType = pgEnum('actor_type', ['system', 'ai', 'candidate', 'reviewer']);

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();

// One row per canonical term. `match_key` is the name compared case- and
// space-insensitively, so each term is written once per category.
export const canonicalTerms = pgTable(
  'canonical_terms',
  {
    termId: uuid('term_id').primaryKey().defaultRandom(),
    category: canonicalCategory('category').notNull(),
    canonicalName: text('canonical_name').notNull(),
    matchKey: text('match_key').notNull(),
    status: canonicalStatus('status').default('active').notNull(),
    // Set when this term was merged into another one.
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => canonicalTerms.termId, {
      onDelete: 'set null'
    }),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('canonical_terms_category_match_key_unique').on(table.category, table.matchKey)
  ]
);

// Another way to write a canonical term, such as "JS" for "JavaScript".
export const aliases = pgTable(
  'aliases',
  {
    aliasId: uuid('alias_id').primaryKey().defaultRandom(),
    termId: uuid('term_id')
      .notNull()
      .references(() => canonicalTerms.termId, { onDelete: 'cascade' }),
    aliasText: text('alias_text').notNull(),
    matchKey: text('match_key').notNull(),
    scope: aliasScope('scope').default('global').notNull(),
    origin: aliasOrigin('origin').notNull(),
    status: aliasStatus('status').default('pending').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('aliases_term_id_match_key_unique').on(table.termId, table.matchKey),
    index('aliases_match_key_idx').on(table.matchKey)
  ]
);

// One row per normalization of a claim. The newest decision of a claim is the
// current one; older decisions are its history. Claim values are never
// changed; the value that was normalized is kept here.
export const normalizationDecisions = pgTable(
  'normalization_decisions',
  {
    normalizationId: uuid('normalization_id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    termId: uuid('term_id').references(() => canonicalTerms.termId, { onDelete: 'set null' }),
    originalValue: text('original_value').notNull(),
    method: normalizationMethod('method'),
    confidenceScore: numeric('confidence_score', { precision: 3, scale: 2, mode: 'number' }),
    actorType: actorType('actor_type').notNull(),
    ruleVersion: text('rule_version').notNull(),
    status: normalizationStatus('status').notNull(),
    createdAt: createdAt()
  },
  (table) => [index('normalization_decisions_claim_id_idx').on(table.claimId, table.createdAt)]
);

export const aiRequestStatus = pgEnum('normalization_ai_request_status', [
  'queued',
  'processing',
  'completed',
  'failed',
  // The claim's value changed before the request finished.
  'superseded'
]);

export type AiRequestStatus = (typeof aiRequestStatus.enumValues)[number];

// A value that exact and spelling matching could not link, waiting for the AI.
// The worker processes these in the background, so saving a claim never waits
// for the AI, and a request survives restarts.
export const normalizationAiRequests = pgTable(
  'normalization_ai_requests',
  {
    requestId: uuid('request_id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.claimId, { onDelete: 'cascade' }),
    category: canonicalCategory('category').notNull(),
    originalValue: text('original_value').notNull(),
    // Other fields of the claim, such as the employer of a job title.
    context: jsonb('context').$type<Record<string, string>>().default({}).notNull(),
    // Terms that spelling matching found equally close, offered to the AI first.
    preferredTermIds: jsonb('preferred_term_ids').$type<string[]>().default([]).notNull(),
    status: aiRequestStatus('status').default('queued').notNull(),
    // Increases with each claim of the request; writes by an older claim fail.
    attemptCount: integer('attempt_count').default(0).notNull(),
    failureCode: text('failure_code'),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex('normalization_ai_requests_active_claim_unique')
      .on(table.claimId)
      .where(isActiveAiRequest(table.status)),
    index('normalization_ai_requests_runnable_idx').on(table.status, table.availableAt)
  ]
);

// Written as literals so an insert's conflict target can repeat the partial
// index's condition exactly.
export function isActiveAiRequest(status: AnyPgColumn): SQL {
  return sql`${status} in ('queued', 'processing')`;
}
