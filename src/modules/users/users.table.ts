import { sql } from 'drizzle-orm';
import {
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', [
  'candidate',
  'reviewer',
  'admin'
]);

export const accountStatus = pgEnum('account_status', [
  'active',
  'suspended',
  'disabled'
]);

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    role: userRole('role').default('candidate').notNull(),
    accountStatus: accountStatus('account_status').default('active').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', {
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
    check('users_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'users_email_normalized',
      sql`${table.email} = lower(btrim(${table.email})) and length(${table.email}) > 0`
    ),
    uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`)
  ]
);
