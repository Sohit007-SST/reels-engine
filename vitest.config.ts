import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    // Tests must never use real keys: point the config loader at the template.
    env: { ENV_FILE: 'api_keys/.env.example' },
  },
});
