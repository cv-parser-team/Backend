import { inspect } from 'node:util';

try {
  process.loadEnvFile();
} catch (err) {
  // Ignore only a missing .env file; surface every other error
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

export function extractOrThrow(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

const ALLOWED_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof ALLOWED_ENVS)[number];

function parseNodeEnv(raw: string): NodeEnv {
  if (!ALLOWED_ENVS.includes(raw as NodeEnv)) {
    throw new Error(`NODE_ENV must be one of: ${ALLOWED_ENVS.join(', ')}`);
  }
  return raw as NodeEnv;
}

function validateJwtSecret(secret: string): string {
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }
  if (new Set(secret).size < 12) {
    throw new Error('JWT_SECRET has too little variety (looks weak)');
  }
  if (/change.?me|secret|password|example|default/i.test(secret)) {
    throw new Error('JWT_SECRET looks like a placeholder value');
  }
  return secret;
}

function validateDatabaseUrl(raw: string, isProd: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres/postgresql protocol');
  }
  const ssl = url.searchParams.get('sslmode');
  if (isProd && !['require', 'verify-ca', 'verify-full'].includes(ssl ?? '')) {
    throw new Error('DATABASE_URL must enforce TLS (sslmode=require) in production');
  }
  return raw;
}

const nodeEnv = parseNodeEnv(extractOrThrow('NODE_ENV'));
const isProd = nodeEnv === 'production';

const jwtSecret = validateJwtSecret(extractOrThrow('JWT_SECRET'));
// Don't leave the secret lying around in process.env
delete process.env.JWT_SECRET;

const rawConfig = {
  port: parsePort(extractOrThrow('PORT')),
  host: extractOrThrow('HOST'),
  nodeEnv,
  isDev: nodeEnv === 'development',
  isProd,
  db: Object.freeze({
    url: validateDatabaseUrl(extractOrThrow('DATABASE_URL'), isProd)
  }),
  auth: Object.freeze({
    jwtSecret,
    issuer: extractOrThrow('JWT_ISSUER'),
    audience: extractOrThrow('JWT_AUDIENCE')
  })
};

// Safe view for logging: never prints secrets or DB credentials
function redacted() {
  return {
    ...rawConfig,
    db: { url: '[REDACTED]' },
    auth: { ...rawConfig.auth, jwtSecret: '[REDACTED]' }
  };
}

Object.defineProperty(rawConfig, 'toJSON', { value: redacted, enumerable: false });
Object.defineProperty(rawConfig, inspect.custom, { value: redacted, enumerable: false });

export const config = Object.freeze(rawConfig);