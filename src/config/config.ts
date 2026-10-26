export function extractOrThrow<T>(
  value: T | null | undefined,
  name: string
): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const nodeEnv = extractOrThrow(process.env.NODE_ENV, 'NODE_ENV');

export const config = {
  port: parseInt(extractOrThrow(process.env.PORT, 'PORT'), 10),
  host: extractOrThrow(process.env.HOST, 'HOST'),
  nodeEnv,
  isDev: nodeEnv === 'development',
  isProd: nodeEnv === 'production',
  db: {
    url: extractOrThrow(process.env.DATABASE_URL, 'DATABASE_URL')
  }
} as const;
