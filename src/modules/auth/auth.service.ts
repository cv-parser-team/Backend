import {
  AccountUnavailableError,
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

export interface AuthService {
  register(input: RegisterBody): Promise<AuthResult>;
  signIn(input: SignInBody): Promise<AuthResult>;
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
): Promise<AuthResult> {
  const accessToken = await jwtService.issueAccessToken({
    userId: state.userId,
    role: state.role,
    tokenVersion: state.tokenVersion
  });

  return { userId: state.userId, accessToken };
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

    async logout(userId) {
      await repository.incrementTokenVersion(userId);
    }
  };
}
