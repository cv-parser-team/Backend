import { AppDatabase } from '../../infrastructure/database/database.js';

export interface StoredRefreshToken {
  tokenId: string;
  familyId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface AuthRepository {
  storeRefreshToken(token: StoredRefreshToken): Promise<void>;
  rotateRefreshToken(
    currentTokenHash: string,
    replacement: StoredRefreshToken
  ): Promise<void>;
  revokeTokenFamily(familyId: string): Promise<void>;
  revokeAllUserTokens(userId: string): Promise<void>;
  revokeAccessToken(
    tokenId: string,
    userId: string,
    expiresAt: Date
  ): Promise<void>;
  isAccessTokenRevoked(tokenId: string): Promise<boolean>;
}

function pending(operation: string): never {
  throw new Error(`Auth repository ${operation} is not implemented`);
}

export function createAuthRepository(_database: AppDatabase): AuthRepository {
  return {
    async storeRefreshToken(_token) {
      return pending('storeRefreshToken');
    },
    async rotateRefreshToken(_currentTokenHash, _replacement) {
      return pending('rotateRefreshToken');
    },
    async revokeTokenFamily(_familyId) {
      return pending('revokeTokenFamily');
    },
    async revokeAllUserTokens(_userId) {
      return pending('revokeAllUserTokens');
    },
    async revokeAccessToken(_tokenId, _userId, _expiresAt) {
      return pending('revokeAccessToken');
    },
    async isAccessTokenRevoked(_tokenId) {
      return pending('isAccessTokenRevoked');
    }
  };
}
