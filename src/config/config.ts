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
  }
} as const;
