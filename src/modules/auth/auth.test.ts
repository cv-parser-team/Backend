import { getTableConfig } from 'drizzle-orm/pg-core';
import Fastify, { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidCredentialsError } from './auth.errors.js';
import { AuthGuards, createAuthGuards } from './auth.guards.js';
import { AuthRepository, AuthState } from './auth.repository.js';
import { authRoutes } from './auth.routes.js';
import { AuthService, createAuthService } from './auth.service.js';
import { authTokenVersions } from './auth.table.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createJwtService,
  JwtService,
  REFRESH_TOKEN_TTL_SECONDS,
  UserRole
} from './jwt-service.js';
import { createPasswordHasher, PasswordHasher } from './password-hasher.js';

describe('auth foundation', () => {
  it('defines one token-version record per user', () => {
    const config = getTableConfig(authTokenVersions);

    expect(authTokenVersions.userId).toBeDefined();
    expect(authTokenVersions.version).toBeDefined();
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.checks).toHaveLength(1);
  });

  it('uses 15-minute access tokens', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000);
  });

  it(
    'hashes and verifies passwords with Argon2id',
    async () => {
      const passwordHasher = createPasswordHasher();
      const hash = await passwordHasher.hash('secure-password');

      expect(hash).toMatch(/^\$argon2id\$/);
      await expect(
        passwordHasher.verify(hash, 'secure-password')
      ).resolves.toBe(true);
      await expect(
        passwordHasher.verify(hash, 'wrong-password')
      ).resolves.toBe(false);
    },
    20_000
  );

  it('issues and verifies JWTs that expire after 15 minutes', async () => {
    const jwtService = createJwtService({
      secret: 'test-jwt-secret-with-at-least-32-characters',
      issuer: 'test-issuer',
      audience: 'test-audience'
    });
    const claims = {
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'candidate' as const,
      tokenVersion: 3
    };

    const token = await jwtService.issueAccessToken(claims);
    const payload = decodeJwt(token);

    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(900);
    await expect(jwtService.verifyAccessToken(token)).resolves.toEqual(claims);

    const refreshToken = await jwtService.issueRefreshToken(claims);
    const refreshPayload = decodeJwt(refreshToken);
    expect((refreshPayload.exp ?? 0) - (refreshPayload.iat ?? 0)).toBe(
      REFRESH_TOKEN_TTL_SECONDS
    );
    await expect(jwtService.verifyRefreshToken(refreshToken)).resolves.toEqual(
      claims
    );
    await expect(jwtService.verifyAccessToken(refreshToken)).rejects.toThrow();
  });
});

const activeCandidate: AuthState = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'candidate',
  accountStatus: 'active',
  tokenVersion: 2
};

function createRepositoryDouble(
  state: AuthState | null = activeCandidate
): AuthRepository {
  return {
    createCandidate: vi.fn().mockResolvedValue(state ?? activeCandidate),
    findCredentialsByEmail: vi.fn().mockResolvedValue(
      state ? { ...state, passwordHash: 'password-hash' } : null
    ),
    getTokenVersion: vi.fn().mockResolvedValue(state?.tokenVersion ?? null),
    getAuthState: vi.fn().mockResolvedValue(state),
    incrementTokenVersion: vi.fn().mockResolvedValue(
      (state?.tokenVersion ?? 0) + 1
    )
  };
}

function createJwtDouble(tokenVersion = 2): JwtService {
  return {
    issueAccessToken: vi.fn().mockResolvedValue('access-token'),
    verifyAccessToken: vi.fn().mockResolvedValue({
      userId: activeCandidate.userId,
      role: 'admin',
      tokenVersion
    }),
    issueRefreshToken: vi.fn().mockResolvedValue('refresh-token'),
    verifyRefreshToken: vi.fn().mockResolvedValue({
      userId: activeCandidate.userId,
      role: 'admin',
      tokenVersion
    })
  };
}

function createPasswordHasherDouble(): PasswordHasher {
  return {
    hash: vi.fn().mockResolvedValue('hashed-password'),
    verify: vi.fn().mockResolvedValue(true)
  };
}

describe('auth service', () => {
  it('registers a normalized candidate and issues its versioned token', async () => {
    const repository = createRepositoryDouble();
    const passwordHasher = createPasswordHasherDouble();
    const jwtService = createJwtDouble();
    const service = createAuthService({
      repository,
      passwordHasher,
      jwtService,
      dummyPasswordHash: 'dummy-hash'
    });

    const result = await service.register({
      name: '  Example User  ',
      email: '  USER@Example.com ',
      password: 'secure-password'
    });

    expect(passwordHasher.hash).toHaveBeenCalledWith('secure-password');
    expect(repository.createCandidate).toHaveBeenCalledWith({
      name: 'Example User',
      email: 'user@example.com',
      passwordHash: 'hashed-password'
    });
    expect(jwtService.issueAccessToken).toHaveBeenCalledWith({
      userId: activeCandidate.userId,
      role: 'candidate',
      tokenVersion: 2
    });
    expect(result.accessToken).toBe('access-token');
  });

  it('uses the dummy hash and returns a generic error for unknown users', async () => {
    const repository = createRepositoryDouble(null);
    const passwordHasher = createPasswordHasherDouble();
    const service = createAuthService({
      repository,
      passwordHasher,
      jwtService: createJwtDouble(),
      dummyPasswordHash: 'dummy-hash'
    });

    await expect(
      service.signIn({
        email: 'missing@example.com',
        password: 'secure-password'
      })
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(passwordHasher.verify).toHaveBeenCalledWith(
      'dummy-hash',
      'secure-password'
    );
  });

  it('increments the token version on logout', async () => {
    const repository = createRepositoryDouble();
    const service = createAuthService({
      repository,
      passwordHasher: createPasswordHasherDouble(),
      jwtService: createJwtDouble(),
      dummyPasswordHash: 'dummy-hash'
    });

    await service.logout(activeCandidate.userId);

    expect(repository.incrementTokenVersion).toHaveBeenCalledWith(
      activeCandidate.userId
    );
  });

  it('refreshes a session only while its account and token version are current', async () => {
    const repository = createRepositoryDouble();
    const jwtService = createJwtDouble();
    const service = createAuthService({
      repository,
      passwordHasher: createPasswordHasherDouble(),
      jwtService,
      dummyPasswordHash: 'dummy-hash'
    });

    await expect(service.refresh('old-refresh-token')).resolves.toEqual({
      userId: activeCandidate.userId,
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    });
    expect(jwtService.verifyRefreshToken).toHaveBeenCalledWith(
      'old-refresh-token'
    );
    expect(repository.getAuthState).toHaveBeenCalledWith(activeCandidate.userId);
  });
});

async function createProtectedApp(
  repository: AuthRepository,
  jwtService: JwtService,
  roles: UserRole[] = ['candidate']
): Promise<FastifyInstance> {
  const app = Fastify();
  const guards = createAuthGuards({ repository, jwtService });

  app.get(
    '/protected',
    {
      preHandler: [
        guards.authenticate,
        guards.requireActiveAccount,
        guards.requireRole(...roles)
      ]
    },
    async (request) => request.auth
  );
  await app.ready();
  return app;
}

describe('auth guards', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('authenticates a matching token version with current database state', async () => {
    const repository = createRepositoryDouble();
    const jwtService = createJwtDouble();
    app = await createProtectedApp(repository, jwtService);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(jwtService.verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(repository.getAuthState).toHaveBeenCalledWith(activeCandidate.userId);
    expect(response.json()).toEqual(activeCandidate);
  });

  it('rejects missing credentials and token-version mismatches', async () => {
    app = await createProtectedApp(
      createRepositoryDouble(),
      createJwtDouble(1)
    );

    const missingResponse = await app.inject({
      method: 'GET',
      url: '/protected'
    });
    const staleResponse = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer stale-token' }
    });

    expect(missingResponse.statusCode).toBe(401);
    expect(staleResponse.statusCode).toBe(401);
  });

  it('rejects inactive accounts', async () => {
    app = await createProtectedApp(
      createRepositoryDouble({
        ...activeCandidate,
        accountStatus: 'suspended'
      }),
      createJwtDouble()
    );

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' }
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects users without an allowed current role', async () => {
    app = await createProtectedApp(
      createRepositoryDouble(),
      createJwtDouble(),
      ['admin']
    );

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' }
    });

    expect(response.statusCode).toBe(403);
  });

  it('converts JWT verification failures to authentication errors', async () => {
    const jwtService = createJwtDouble();
    vi.mocked(jwtService.verifyAccessToken).mockRejectedValue(
      new Error('signature details must not escape')
    );
    app = await createProtectedApp(createRepositoryDouble(), jwtService);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer invalid-token' }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe('Invalid or expired access token');
  });
});

function createService(): AuthService {
  return {
    register: vi.fn().mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    }),
    signIn: vi.fn().mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    }),
    refresh: vi.fn().mockResolvedValue({
      userId: '11111111-1111-4111-8111-111111111111',
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token'
    }),
    logout: vi.fn().mockResolvedValue(undefined)
  };
}

function createGuards(): AuthGuards {
  const authenticate: preHandlerHookHandler = (request, _reply, done) => {
    request.auth = {
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'candidate',
      accountStatus: 'active',
      tokenVersion: 0
    };
    done();
  };
  const requireActiveAccount: preHandlerHookHandler = (
    _request,
    _reply,
    done
  ) => done();

  return {
    authenticate,
    requireActiveAccount,
    requireRole() {
      return (_request, _reply, done) => done();
    },
    requireSelfOrRole() {
      return (_request, _reply, done) => done();
    }
  };
}

describe('auth routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('registers a candidate with validated input', async () => {
    const service = createService();
    app = Fastify();
    await app.register(authRoutes, {
      prefix: '/api/auth',
      service,
      guards: createGuards()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Example User',
        email: 'user@example.com',
        password: 'secure-password'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(service.register).toHaveBeenCalledWith({
      name: 'Example User',
      email: 'user@example.com',
      password: 'secure-password'
    });
    expect(response.json()).toMatchObject({
      success: true,
      data: { accessToken: 'access-token' }
    });
    expect(response.headers['set-cookie']).toContain('HttpOnly');
  });

  it('signs in with validated credentials', async () => {
    const service = createService();
    app = Fastify();
    await app.register(authRoutes, {
      prefix: '/api/auth',
      service,
      guards: createGuards()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      payload: {
        email: 'user@example.com',
        password: 'secure-password'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(service.signIn).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'secure-password'
    });
  });

  it('logs out the authenticated user', async () => {
    const service = createService();
    app = Fastify();
    await app.register(authRoutes, {
      prefix: '/api/auth',
      service,
      guards: createGuards()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout'
    });

    expect(response.statusCode).toBe(204);
    expect(service.logout).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('refreshes from the HttpOnly cookie without exposing it in the body', async () => {
    const service = createService();
    app = Fastify();
    await app.register(authRoutes, {
      prefix: '/api/auth',
      service,
      guards: createGuards()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: 'luminaCV_refresh=old-refresh-token' }
    });

    expect(response.statusCode).toBe(200);
    expect(service.refresh).toHaveBeenCalledWith('old-refresh-token');
    expect(response.json().data).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      accessToken: 'new-access-token'
    });
    expect(response.headers['set-cookie']).toContain('new-refresh-token');
  });

  it('rejects registration with a short password', async () => {
    const service = createService();
    app = Fastify();
    await app.register(authRoutes, {
      prefix: '/api/auth',
      service,
      guards: createGuards()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        name: 'Example User',
        email: 'user@example.com',
        password: 'short'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(service.register).not.toHaveBeenCalled();
  });
});
