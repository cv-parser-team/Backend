import { preHandlerHookHandler } from 'fastify';
import { UserRole } from './jwt-service.js';

export interface AuthenticatedPrincipal {
  userId: string;
  tokenId: string;
  role: UserRole;
}

export interface AuthGuards {
  authenticate: preHandlerHookHandler;
  requireActiveAccount: preHandlerHookHandler;
  requireRole(...roles: UserRole[]): preHandlerHookHandler;
}

function pending(): never {
  throw new Error('Authentication guards are not implemented');
}

export function createAuthGuards(): AuthGuards {
  return {
    authenticate(_request, _reply, _done) {
      return pending();
    },
    requireActiveAccount(_request, _reply, _done) {
      return pending();
    },
    requireRole(..._roles) {
      return (_request, _reply, _done) => pending();
    }
  };
}
