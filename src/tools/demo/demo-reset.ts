import { ilike, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../infrastructure/database/database.js';
import { documents } from '../../modules/documents/documents.table.js';
import type { DocumentStorage } from '../../modules/documents/documents.storage.js';
import { authTokenVersions } from '../../modules/auth/auth.table.js';
import { users } from '../../modules/users/users.table.js';
import { DEMO_EMAIL_DOMAIN } from './demo-data.js';
import type { DemoUserInput } from './demo-seed.js';

// The rows that demo tools read and remove. Everything a demo user owns
// (profile, claims, decisions, documents, review items) cascades from the user.
export interface DemoStore {
  findDemoUserIds(): Promise<string[]>;
  findDocumentStorageKeys(userIds: string[]): Promise<string[]>;
  deleteUsers(userIds: string[]): Promise<void>;
  // Creates an active user with its token version, as registration does, so
  // the account can sign in.
  createUser(input: DemoUserInput): Promise<{ userId: string }>;
}

export function createDemoStore(database: AppDatabase): DemoStore {
  return {
    async createUser(input) {
      return database.db.transaction(async (transaction) => {
        const [user] = await transaction
          .insert(users)
          .values({ ...input, accountStatus: 'active' })
          .returning({ userId: users.userId });
        if (!user) {
          throw new Error('Demo user creation returned no record');
        }
        await transaction.insert(authTokenVersions).values({ userId: user.userId });
        return user;
      });
    },

    async findDemoUserIds() {
      const rows = await database.db
        .select({ userId: users.userId })
        .from(users)
        .where(ilike(users.email, `%@${DEMO_EMAIL_DOMAIN}`));
      return rows.map((row) => row.userId);
    },

    async findDocumentStorageKeys(userIds) {
      if (userIds.length === 0) {
        return [];
      }
      const rows = await database.db
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .where(inArray(documents.ownerUserId, userIds));
      return rows.map((row) => row.storageKey);
    },

    async deleteUsers(userIds) {
      if (userIds.length > 0) {
        await database.db.delete(users).where(inArray(users.userId, userIds));
      }
    }
  };
}

// Demo tools write to whatever database the environment points at, so they
// refuse to run in production.
export function assertDemoAllowed(nodeEnv: string): void {
  if (nodeEnv === 'production') {
    throw new Error('Demo data cannot be used in production');
  }
}

export interface DemoResetDependencies {
  store: DemoStore;
  storage: Pick<DocumentStorage, 'delete'>;
  nodeEnv: string;
}

export interface DemoResetResult {
  users: number;
  files: number;
}

// Removes every demo user and what they own, and nothing else. Files are
// deleted before their rows, so a failure leaves rows that a later reset can
// find again rather than files no row points to.
export async function resetDemoData({
  store,
  storage,
  nodeEnv
}: DemoResetDependencies): Promise<DemoResetResult> {
  assertDemoAllowed(nodeEnv);

  const userIds = await store.findDemoUserIds();
  const storageKeys = await store.findDocumentStorageKeys(userIds);
  for (const storageKey of storageKeys) {
    await storage.delete(storageKey);
  }
  await store.deleteUsers(userIds);

  return { users: userIds.length, files: storageKeys.length };
}
