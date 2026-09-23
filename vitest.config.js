import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.js', 'apps/*/test/**/*.test.js'],
    // Each database test file starts and stops a real PostgreSQL. On a slow CI runner that alone
    // can outlast the 10-second default and fail a file whose tests all passed.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
