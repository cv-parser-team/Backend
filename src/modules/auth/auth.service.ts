import {
  AccountUnavailableError,
  AuthenticationError,
  InvalidCredentialsError
} from './auth.errors.js';
import { AuthRepository, AuthState } from './auth.repository.js';
import { RegisterBody, SignInBody } from './auth.schemas.js';
import { JwtService } from './jwt-service.js';
import { PasswordHasher } from './password-hasher.js';

export interface AuthToken {
  accessToken: string;
}

export interface AuthResult extends AuthToken {
  userId: string;
}

export interface AuthSession extends AuthResult {
  refreshToken: string;
}

export interface AuthService {
  register(input: RegisterBody): Promise<AuthSession>;
  signIn(input: SignInBody): Promise<AuthSession>;
  refresh(refreshToken: string | undefined): Promise<AuthSession>;
  logout(userId: string): Promise<void>;
}

export interface AuthServiceDependencies {
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  jwtService: JwtService;
  dummyPasswordHash: string;
}

async function issueResult(
  jwtService: JwtService,
  state: AuthState
): Promise<AuthSession> {
  const claims = {
    userId: state.userId,
    role: state.role,
    tokenVersion: state.tokenVersion
  };
  const [accessToken, refreshToken] = await Promise.all([
    jwtService.issueAccessToken(claims),
    jwtService.issueRefreshToken(claims)
  ]);

  return { userId: state.userId, accessToken, refreshToken };
}

export function createAuthService({
  repository,
  passwordHasher,
  jwtService,
  dummyPasswordHash
}: AuthServiceDependencies): AuthService {
  return {
    async register(input) {
      const passwordHash = await passwordHasher.hash(input.password);
      const candidate = await repository.createCandidate({
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        passwordHash
      });

      return issueResult(jwtService, candidate);
    },

    async signIn(input) {
      const credentials = await repository.findCredentialsByEmail(input.email);
      const passwordHash = credentials?.passwordHash ?? dummyPasswordHash;
      const validPassword = await passwordHasher.verify(
        passwordHash,
        input.password
      );

      if (!credentials || !validPassword || !credentials.passwordHash) {
        throw new InvalidCredentialsError();
      }

      if (credentials.accountStatus !== 'active') {
        throw new AccountUnavailableError('Account is not active');
      }

      return issueResult(jwtService, credentials);
    },

    async refresh(refreshToken) {
      if (!refreshToken) {
        throw new AuthenticationError('Refresh token required');
      }

      let claims;
      try {
        claims = await jwtService.verifyRefreshToken(refreshToken);
      } catch {
        throw new AuthenticationError('Invalid or expired refresh token');
      }

      const state = await repository.getAuthState(claims.userId);
      if (!state || state.tokenVersion !== claims.tokenVersion) {
        throw new AuthenticationError('Invalid or expired refresh token');
      }
      if (state.accountStatus !== 'active') {
        throw new AccountUnavailableError('Account is not active');
      }

      return issueResult(jwtService, state);
    },

    async logout(userId) {
      await repository.incrementTokenVersion(userId);
    }
  };
}
