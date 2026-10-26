import { eq } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { users } from './users.table.js';

export type UserRecord = typeof users.$inferSelect;
export type CreateUserInput = Omit<
  typeof users.$inferInsert,
  'userId' | 'createdAt' | 'updatedAt'
>;

export interface UsersRepository {
  findAll(): Promise<UserRecord[]>;
  findById(userId: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
}

export function createUsersRepository(
  database: AppDatabase
): UsersRepository {
  return {
    async findAll() {
      return withDbErrors('Users', () => database.db.select().from(users));
    },

    async findById(userId) {
      return withDbErrors('User', async () => {
        const [user] = await database.db
          .select()
          .from(users)
          .where(eq(users.userId, userId))
          .limit(1);

        return user ?? null;
      });
    },

    async findByEmail(email) {
      return withDbErrors('User', async () => {
        const [user] = await database.db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        return user ?? null;
      });
    },

    async create(input) {
      return withDbErrors('User', async () => {
        const [createdUser] = await database.db
          .insert(users)
          .values(input)
          .returning();

        if (!createdUser) {
          throw new Error('User creation did not return a record');
        }

        return createdUser;
      });
    }
  };
}
