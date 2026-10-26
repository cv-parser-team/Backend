import { AuthRepository } from './auth.repository.js';
import { RegisterBody, SignInBody } from './auth.schemas.js';
import { JwtService } from './jwt-service.js';
import { PasswordHasher } from './password-hasher.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  userId: string;
}

export interface AuthService {
  register(input: RegisterBody): Promise<AuthResult>;
  signIn(input: SignInBody): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<AuthTokens>;
  logout(accessToken: string, refreshToken: string): Promise<void>;
  logoutAll(userId: string): Promise<void>;
}

export interface AuthServiceDependencies {
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  jwtService: JwtService;
}

function pending(operation: string): never {
  throw new Error(`Auth ${operation} is not implemented`);
}

export function createAuthService(
  _dependencies: AuthServiceDependencies
): AuthService {
  return {
    async register(_input) {
      return pending('registration');
    },
    async signIn(_input) {
      return pending('sign-in');
    },
    async refresh(_refreshToken) {
      return pending('refresh');
    },
    async logout(_accessToken, _refreshToken) {
      return pending('logout');
    },
    async logoutAll(_userId) {
      return pending('logout-all');
    }
  };
}
