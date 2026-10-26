import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['candidate', 'admin']);

export const accountStatus = pgEnum('account_status', [
  'active',
  'suspended',
  'disabled'
]);

export const users = pgTable('users', {
  userId: uuid('user_id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
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
});
