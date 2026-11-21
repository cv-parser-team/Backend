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

export function extractPositiveIntegerOrDefault(
  name: string,
  defaultValue: number
): number {
  const rawValue = process.env[name];

  return rawValue === undefined || rawValue === ''
    ? defaultValue
    : extractPositiveIntegerOrThrow(name);
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
  // The public URL of the API, listed in the OpenAPI document.
  publicApiUrl: process.env.PUBLIC_API_URL || 'http://localhost:4000',
  db: {
    url: extractOrThrow('DATABASE_URL')
  },
  messaging: {
    rabbitMqUrl:
      process.env.RABBITMQ_URL ||
      'amqp://luminacv:luminacvpassword@localhost:5672'
  },
  llm: {
    provider: process.env.LLM_PROVIDER || 'gemini',
    model: process.env.LLM_MODEL || 'gemini-3.5-flash-lite',
    apiKey: process.env.LLM_API_KEY || undefined,
    timeoutMs: extractPositiveIntegerOrDefault('LLM_TIMEOUT_MS', 30_000),
    maximumInputCharacters: extractPositiveIntegerOrDefault(
      'LLM_MAX_INPUT_CHARS',
      100_000
    )
  },
  normalization: {
    // AI matching also needs LLM_API_KEY; without it, it stays off.
    aiEnabled: process.env.NORMALIZATION_AI_ENABLED !== 'false',
    aiPollIntervalMs: extractPositiveIntegerOrDefault(
      'NORMALIZATION_AI_POLL_INTERVAL_MS',
      5_000
    ),
    aiBatchSize: extractPositiveIntegerOrDefault('NORMALIZATION_AI_BATCH_SIZE', 10)
  },
  candidates: {
    // Close employment/education date ranges use a bounded AI identity check.
    duplicateAiEnabled: process.env.DUPLICATE_AI_ENABLED !== 'false'
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
    ),
    stagingMaximumAgeSeconds: extractPositiveIntegerOrDefault(
      'DOCUMENT_STAGING_MAX_AGE_SECONDS',
      86_400
    ),
    orphanGracePeriodSeconds: extractPositiveIntegerOrDefault(
      'DOCUMENT_ORPHAN_GRACE_PERIOD_SECONDS',
      86_400
    )
  }
} as const;
