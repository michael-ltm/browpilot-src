import { defineConfig } from 'vitest/config';

// Default (hermetic) unit run: every package's own test/ dirs, never the
// real-Chrome integration suite.
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'scripts/lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
