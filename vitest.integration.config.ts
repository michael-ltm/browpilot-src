import { defineConfig } from 'vitest/config';

// Integration + soak tests launch a real Chrome and an in-process broker.
// They are slow and require RUN_BROWSER_TESTS=1; the gate inside each test
// turns the whole file into a no-op when the flag is absent, but we also
// scope the runner here so `npm test` (unit) never touches them.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
