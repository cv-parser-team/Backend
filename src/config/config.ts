import { parse, resolve } from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // Ignore if .env is missing
}

export function extractOrThrow(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function extractPositiveIntegerOrThrow(name: string): number {
  const rawValue = extractOrThrow(name);
  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

export function extractPrivateDirectoryOrThrow(name: string): string {
  const directory = resolve(extractOrThrow(name));

  if (directory === parse(directory).root) {
    throw new Error(`${name} must not be a filesystem root`);
  }

  return directory;
}

const nodeEnv = extractOrThrow('NODE_ENV');
const jwtSecret = extractOrThrow('JWT_SECRET');

if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters');
}

export const config = {
  port: parseInt(extractOrThrow('PORT'), 10),
  host: extractOrThrow('HOST'),
  nodeEnv,
  isDev: nodeEnv === 'development',
  isProd: nodeEnv === 'production',
  db: {
    url: extractOrThrow('DATABASE_URL')
  },
  auth: {
    jwtSecret,
    issuer: extractOrThrow('JWT_ISSUER'),
    audience: extractOrThrow('JWT_AUDIENCE')
  },
  documents: {
    storageRoot: extractPrivateDirectoryOrThrow('DOCUMENT_STORAGE_ROOT'),
    maximumUploadFiles: extractPositiveIntegerOrThrow(
      'DOCUMENT_MAX_UPLOAD_FILES'
    ),
    maximumUploadByteSize: extractPositiveIntegerOrThrow(
      'DOCUMENT_MAX_UPLOAD_BYTES'
    )
  }
} as const;
