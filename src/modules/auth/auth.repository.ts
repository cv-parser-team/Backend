import { eq, sql } from 'drizzle-orm';
import { AppDatabase } from '../../infrastructure/database/database.js';
import { withDbErrors } from '../../infrastructure/database/database.errors.js';
import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { users } from '../users/users.table.js';
import { authTokenVersions } from './auth.table.js';

export interface AuthState {
  userId: string;
  role: 'candidate' | 'reviewer' | 'admin';
  accountStatus: 'active' | 'suspended' | 'disabled';
  tokenVersion: number;
}

export interface AuthCredentials extends AuthState {
  passwordHash: string | null;
}

export interface CreateCandidateInput {
  name: string;
  email: string;
  passwordHash: string;
}

export interface AuthRepository {
  createCandidate(input: CreateCandidateInput): Promise<AuthState>;
  findCredentialsByEmail(email: string): Promise<AuthCredentials | null>;
  getTokenVersion(userId: string): Promise<number | null>;
  getAuthState(userId: string): Promise<AuthState | null>;
  incrementTokenVersion(userId: string): Promise<number>;
}

export function createAuthRepository(database: AppDatabase): AuthRepository {
  return {
    async createCandidate(input) {
      return withDbErrors('User', () => {
        return database.db.transaction(async (transaction) => {
          const [createdUser] = await transaction
            .insert(users)
            .values({
              name: input.name,
              email: input.email,
              passwordHash: input.passwordHash,
              role: 'candidate',
              accountStatus: 'active'
            })
            .returning({
              userId: users.userId,
              role: users.role,
              accountStatus: users.accountStatus
            });

          if (!createdUser) {
            throw new Error('Candidate creation did not return a record');
          }

          const [tokenVersion] = await transaction
            .insert(authTokenVersions)
            .values({ userId: createdUser.userId })
            .returning({ version: authTokenVersions.version });

          if (!tokenVersion) {
            throw new Error('Token-version creation did not return a record');
          }

          return {
            ...createdUser,
            tokenVersion: tokenVersion.version
          };
        });
      });
    },
    async findCredentialsByEmail(email) {
      return withDbErrors('User credentials', async () => {
        const normalizedEmail = email.trim().toLowerCase();
        const [record] = await database.db
          .select({
            userId: users.userId,
            passwordHash: users.passwordHash,
            role: users.role,
            accountStatus: users.accountStatus,
            tokenVersion: authTokenVersions.version
          })
          .from(users)
          .innerJoin(
            authTokenVersions,
            eq(authTokenVersions.userId, users.userId)
          )
          .where(eq(users.email, normalizedEmail))
          .limit(1);

        return record ?? null;
      });
    },
    async getTokenVersion(userId) {
      return withDbErrors('Auth token version', async () => {
        const [record] = await database.db
          .select({ version: authTokenVersions.version })
          .from(authTokenVersions)
          .where(eq(authTokenVersions.userId, userId))
          .limit(1);

        return record?.version ?? null;
      });
    },
    async getAuthState(userId) {
      return withDbErrors('Authentication state', async () => {
        const [record] = await database.db
          .select({
            userId: users.userId,
            role: users.role,
            accountStatus: users.accountStatus,
            tokenVersion: authTokenVersions.version
          })
          .from(users)
          .innerJoin(
            authTokenVersions,
            eq(authTokenVersions.userId, users.userId)
          )
          .where(eq(users.userId, userId))
          .limit(1);

        return record ?? null;
      });
    },
    async incrementTokenVersion(userId) {
      return withDbErrors('Auth token version', async () => {
        const [updated] = await database.db
          .update(authTokenVersions)
          .set({
            version: sql`${authTokenVersions.version} + 1`,
            updatedAt: new Date()
          })
          .where(eq(authTokenVersions.userId, userId))
          .returning({ version: authTokenVersions.version });

        if (!updated) {
          throw new RecordNotFoundError('Auth token version', userId);
        }

        return updated.version;
      });
    }
  };
}
