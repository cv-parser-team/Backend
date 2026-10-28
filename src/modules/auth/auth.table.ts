import { sql } from 'drizzle-orm';
import { check, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '../users/users.table.js';

export const authTokenVersions = pgTable(
  'auth_token_versions',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.userId, { onDelete: 'cascade' }),
    version: integer('version').default(0).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date'
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    check('auth_token_versions_nonnegative', sql`${table.version} >= 0`)
  ]
);
