import { jwtVerify, JWTPayload, SignJWT } from 'jose';
import { config } from '../../config/config.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type UserRole = 'candidate' | 'reviewer' | 'admin';

export interface AccessTokenClaims {
  userId: string;
  role: UserRole;
  tokenVersion: number;
}

export type RefreshTokenClaims = AccessTokenClaims;

export interface JwtService {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
  issueRefreshToken(claims: RefreshTokenClaims): Promise<string>;
  verifyRefreshToken(token: string): Promise<RefreshTokenClaims>;
}

export interface JwtServiceOptions {
  secret: string;
  issuer: string;
  audience: string;
}

const roles: ReadonlySet<string> = new Set([
  'candidate',
  'reviewer',
  'admin'
]);

function parseClaims(payload: JWTPayload): AccessTokenClaims {
  const { sub: userId, role, tokenVersion } = payload;

  if (
    typeof userId !== 'string' ||
    typeof role !== 'string' ||
    !roles.has(role) ||
    typeof tokenVersion !== 'number' ||
    !Number.isInteger(tokenVersion) ||
    tokenVersion < 0
  ) {
    throw new Error('Access token contains invalid claims');
  }

  return {
    userId,
    role: role as UserRole,
    tokenVersion
  };
}

export function createJwtService(
  options: JwtServiceOptions = {
    secret: config.auth.jwtSecret,
    issuer: config.auth.issuer,
    audience: config.auth.audience
  }
): JwtService {
  const secret = new TextEncoder().encode(options.secret);
  const refreshAudience = `${options.audience}:refresh`;

  function issueToken(
    claims: AccessTokenClaims,
    audience: string,
    ttlSeconds: number
  ): Promise<string> {
    return new SignJWT({
      role: claims.role,
      tokenVersion: claims.tokenVersion
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(options.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(secret);
  }

  async function verifyToken(
    token: string,
    audience: string
  ): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer: options.issuer,
      audience
    });

    return parseClaims(payload);
  }

  return {
    issueAccessToken(claims) {
      return issueToken(claims, options.audience, ACCESS_TOKEN_TTL_SECONDS);
    },

    verifyAccessToken(token) {
      return verifyToken(token, options.audience);
    },

    issueRefreshToken(claims) {
      return issueToken(claims, refreshAudience, REFRESH_TOKEN_TTL_SECONDS);
    },

    verifyRefreshToken(token) {
      return verifyToken(token, refreshAudience);
    }
  };
}
