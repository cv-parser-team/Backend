import { jwtVerify, JWTPayload, SignJWT } from 'jose';
import { config } from '../../config/config.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export type UserRole = 'candidate' | 'reviewer' | 'admin';

export interface AccessTokenClaims {
  userId: string;
  role: UserRole;
  tokenVersion: number;
}

export interface JwtService {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
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

  return {
    issueAccessToken(claims) {
      return new SignJWT({
        role: claims.role,
        tokenVersion: claims.tokenVersion
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(claims.userId)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
        .sign(secret);
    },

    async verifyAccessToken(token) {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: options.issuer,
        audience: options.audience
      });

      return parseClaims(payload);
    }
  };
}
