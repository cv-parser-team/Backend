import { describe, expect, it, vi } from 'vitest';
import { createUsersService } from './users.service.js';
import { users } from './users.table.js';
import type { UserRecord, UsersRepository } from './users.repository.js';

const userRecord: UserRecord = {
  userId: '11111111-1111-4111-8111-111111111111',
  name: 'Example User',
  email: 'user@example.com',
  passwordHash: 'private',
  role: 'candidate',
  accountStatus: 'active',
  emailVerifiedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z')
};

function createRepository(): UsersRepository {
  return {
    findAll: vi.fn().mockResolvedValue([userRecord]),
    findById: vi.fn().mockResolvedValue(userRecord),
    findByEmail: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(userRecord)
  };
}

describe('users module', () => {
  it('owns the Drizzle users table', () => {
    expect(users.userId).toBeDefined();
    expect(users.email).toBeDefined();
    expect(users.accountStatus).toBeDefined();
  });

  it('normalizes email and does not expose password hashes', async () => {
    const repository = createRepository();
    const service = createUsersService(repository);

    const result = await service.createUser({
      name: 'Example User',
      email: '  USER@Example.com '
    });

    expect(repository.create).toHaveBeenCalledWith({
      name: 'Example User',
      email: 'user@example.com'
    });
    expect(result).not.toHaveProperty('passwordHash');
  });
});
