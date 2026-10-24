import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ['@browpilot/shared', '@browpilot/launcher'],
  banner: { js: '#!/usr/bin/env node' },
});
