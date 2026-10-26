export type UserRole = 'candidate' | 'reviewer' | 'admin';

export interface AccessTokenClaims {
  userId: string;
  tokenId: string;
  role: UserRole;
}

export interface RefreshTokenClaims {
  userId: string;
  tokenId: string;
  familyId: string;
}

export interface JwtService {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
  issueRefreshToken(claims: RefreshTokenClaims): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
  verifyRefreshToken(token: string): Promise<RefreshTokenClaims>;
}

function pending(): never {
  throw new Error('JWT handling is not implemented');
}

export function createJwtService(): JwtService {
  return {
    async issueAccessToken(_claims) {
      return pending();
    },
    async issueRefreshToken(_claims) {
      return pending();
    },
    async verifyAccessToken(_token) {
      return pending();
    },
    async verifyRefreshToken(_token) {
      return pending();
    }
  };
}
