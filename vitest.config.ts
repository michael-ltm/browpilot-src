import { defineConfig } from 'vitest/config';

// Default (hermetic) unit run: every package's own test/ dirs plus the pure
// installer helpers under scripts/lib — never the real-Chrome integration suite
// and never the integration fixture-server test (it lives under test/integration).
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'scripts/lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
