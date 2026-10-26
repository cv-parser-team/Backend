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
      NODE_ENV: 'test'
    }
  }
});
