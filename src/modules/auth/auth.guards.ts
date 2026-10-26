import { preHandlerHookHandler } from 'fastify';
import {
  AccountUnavailableError,
  AuthenticationError,
  AuthorizationError
} from './auth.errors.js';
import { AuthRepository } from './auth.repository.js';
import { JwtService, UserRole } from './jwt-service.js';

export interface AuthenticatedPrincipal {
  userId: string;
  role: UserRole;
  accountStatus: 'active' | 'suspended' | 'disabled';
  tokenVersion: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedPrincipal;
  }
}

export interface AuthGuards {
  authenticate: preHandlerHookHandler;
  requireActiveAccount: preHandlerHookHandler;
  requireRole(...roles: UserRole[]): preHandlerHookHandler;
  requireSelfOrRole(paramName: string, ...roles: UserRole[]): preHandlerHookHandler;
}

export interface AuthGuardDependencies {
  repository: AuthRepository;
  jwtService: JwtService;
}

function extractBearerToken(authorization: string | undefined): string {
  const parts = authorization?.trim().split(/\s+/) ?? [];

  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    throw new AuthenticationError('Authentication required');
  }

  return parts[1];
}

function requirePrincipal(
  principal: AuthenticatedPrincipal | undefined
): AuthenticatedPrincipal {
  if (!principal) {
    throw new AuthenticationError('Authentication required');
  }

  return principal;
}

export function createAuthGuards({
  repository,
  jwtService
}: AuthGuardDependencies): AuthGuards {
  return {
    async authenticate(request) {
      const token = extractBearerToken(request.headers.authorization);
      let claims;

      try {
        claims = await jwtService.verifyAccessToken(token);
      } catch {
        throw new AuthenticationError('Invalid or expired access token');
      }

      const state = await repository.getAuthState(claims.userId);

      if (!state || state.tokenVersion !== claims.tokenVersion) {
        throw new AuthenticationError('Invalid or expired access token');
      }

      request.auth = state;
    },

    async requireActiveAccount(request) {
      const principal = requirePrincipal(request.auth);

      if (principal.accountStatus !== 'active') {
        throw new AccountUnavailableError('Account is not active');
      }
    },

    requireRole(...roles) {
      return async (request) => {
        const principal = requirePrincipal(request.auth);

        if (!roles.includes(principal.role)) {
          throw new AuthorizationError('Insufficient permissions');
        }
      };
    },

    requireSelfOrRole(paramName, ...roles) {
      return async (request) => {
        const principal = requirePrincipal(request.auth);
        const params = request.params;
        const requestedUserId =
          typeof params === 'object' && params !== null
            ? (params as Record<string, unknown>)[paramName]
            : undefined;

        if (
          requestedUserId !== principal.userId &&
          !roles.includes(principal.role)
        ) {
          throw new AuthorizationError('Insufficient permissions');
        }
      };
    }
  };
}
