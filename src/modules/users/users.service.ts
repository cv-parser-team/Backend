import { RecordNotFoundError } from '../../shared/errors/app.error.js';
import { CreateUserInput, UserRecord, UsersRepository } from './users.repository.js';

export type SafeUser = Omit<UserRecord, 'passwordHash'>;
export type CreateUserRequest = Pick<CreateUserInput, 'name' | 'email'>;

export interface UsersService {
  listUsers(): Promise<SafeUser[]>;
  getUserById(userId: string): Promise<SafeUser>;
  createUser(input: CreateUserRequest): Promise<SafeUser>;
}

function sanitizeUser(user: UserRecord): SafeUser {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

export function createUsersService(usersRepository: UsersRepository): UsersService {
  return {
    async listUsers() {
      const records = await usersRepository.findAll();
      return records.map(sanitizeUser);
    },

    async getUserById(userId) {
      const user = await usersRepository.findById(userId);
      if (!user) {
        throw new RecordNotFoundError('User', userId);
      }
      return sanitizeUser(user);
    },

    async createUser(input) {
      const normalizedInput: CreateUserInput = {
        name: input.name.trim(),
        email: input.email.trim().toLowerCase()
      };

      const createdUser = await usersRepository.create(normalizedInput);
      return sanitizeUser(createdUser);
    }
  };
}
