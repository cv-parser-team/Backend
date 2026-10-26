import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      DATABASE_URL:
        'postgresql://postgres:postgrespassword@localhost:5432/luminacv_test',
      PORT: '4000',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      JWT_SECRET: 'test-only-jwt-secret-with-at-least-32-characters',
      JWT_ISSUER: 'luminacv-test',
      JWT_AUDIENCE: 'luminacv-test-api'
    }
  }
});
