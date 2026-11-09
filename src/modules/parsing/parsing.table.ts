import { sql } from 'drizzle-orm';
import {
  check,
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
import { DocumentBlock, ExtractionFailure, ParsedPage } from './parsing.types.js';

// Increase when the shape of `content` changes, so readers can tell stored
// results of different shapes apart.
export const EXTRACTION_CONTENT_VERSION = 3;

export interface ExtractionContent {
  version: number;
  pages: ParsedPage[];
  blocks: DocumentBlock[];
}

// Information from the document that has no place in the candidate profile,
// such as courses or awards, or an item that could not become a claim. It is
// kept for later use instead of being lost.
export interface UnmappedItem {
  // The CV section or field it came from, such as "Courses & Certifications".
  label: string;
  text: string;
  // Line references from the AI input, such as "L12" or "B3".
  sources: string[];
  // Why it was not mapped, such as "unsupported_section" or "missing_start_date".
  reason: string;
}

export const extractionStatus = pgEnum('extraction_status', [
  'succeeded',
  'partial',
  'failed'
]);

export const documentFormat = pgEnum('document_format', ['pdf', 'docx']);

export const documentExtractions = pgTable(
  'document_extractions',
  {
    extractionId: uuid('extraction_id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.documentId, { onDelete: 'cascade' }),
    status: extractionStatus('status').notNull(),
    format: documentFormat('format').notNull(),
    pageCount: integer('page_count'),
    content: jsonb('content').$type<ExtractionContent>().notNull(),
    failures: jsonb('failures').$type<ExtractionFailure[]>().default([]).notNull(),
    // Filled by the AI-output mapping, not by the parser.
    unmappedData: jsonb('unmapped_data').$type<UnmappedItem[]>().default([]).notNull(),
    parserVersion: text('parser_version').notNull(),
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
    uniqueIndex('document_extractions_document_id_unique').on(table.documentId),
    check(
      'document_extractions_page_count_positive',
      sql`${table.pageCount} is null or ${table.pageCount} > 0`
    )
  ]
);
