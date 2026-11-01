import { sql } from 'drizzle-orm';
import {
    bigint,
    check,
    index,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid
} from 'drizzle-orm/pg-core';
import { users } from '../users/users.table.js';
import { documentPurposes } from './documents.formats.js';
import type { DocumentMediaType } from './documents.formats.js';

export const documentPurpose = pgEnum('document_purpose', documentPurposes);

export const documentStatus = pgEnum('document_status', [
    'stored',
    'processing',
    'ready',
    'failed',
    'deleting'
]);

export type DocumentStatus = (typeof documentStatus.enumValues)[number];

export const documents = pgTable(
    'documents',
    {
        documentId: uuid('document_id').primaryKey().defaultRandom(),
        ownerUserId: uuid('owner_user_id')
            .notNull()
            .references(() => users.userId, { onDelete: 'cascade' }),
        purpose: documentPurpose('purpose').notNull(),
        originalFilename: text('original_filename').notNull(),
        mediaType: text('media_type').$type<DocumentMediaType>().notNull(),
        byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
        sha256: text('sha256').notNull(),
        storageKey: text('storage_key').notNull(),
        status: documentStatus('status').default('stored').notNull(),
        failureCode: text('failure_code'),
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
        uniqueIndex('documents_storage_key_unique').on(table.storageKey),
        index('documents_owner_created_at_idx').on(
            table.ownerUserId,
            table.createdAt
        ),
        index('documents_owner_sha256_idx').on(table.ownerUserId, table.sha256),
        check('documents_byte_size_positive', sql`${table.byteSize} > 0`),
        check(
            'documents_original_filename_length',
            sql`length(btrim(${table.originalFilename})) between 1 and 255`
        ),
        check(
            'documents_sha256_format',
            sql`${table.sha256} ~ '^[0-9a-f]{64}$'`
        ),
        check(
            'documents_storage_key_not_blank',
            sql`length(btrim(${table.storageKey})) > 0`
        ),
        check(
            'documents_media_type_supported',
            sql`${table.mediaType} in (
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'image/jpeg',
                'image/png'
            )`
        ),
        check(
            'documents_purpose_media_type_compatible',
            sql`${table.purpose} = 'evidence' or ${table.mediaType} in (
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            )`
        ),
        check(
            'documents_failure_code_status',
            sql`(
                ${table.status} = 'failed' and ${table.failureCode} is not null
            ) or (
                ${table.status} <> 'failed' and ${table.failureCode} is null
            )`
        )
    ]
);
