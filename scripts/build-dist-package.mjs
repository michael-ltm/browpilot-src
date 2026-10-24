// Assembles the publishable `browpilot` package into dist-pkg/:
//   dist/mcp.js   (bin; MCP server, shared bundled, sdk/ws/zod external)
//   dist/broker.js(broker, shared bundled, ws external)
//   extension/    (built extension dist)
// Run: node scripts/build-dist-package.mjs
import { rmSync, mkdirSync, cpSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import esbuild from 'esbuild';
import { makePackageManifest } from './lib/pkg-manifest.ts';

const OUT = 'dist-pkg';
const EXTERNAL = ['@modelcontextprotocol/sdk', 'ws', 'zod'];

// 1. Build the extension (its dist is copied verbatim).
execSync('npm run build -w @browpilot/shared', { stdio: 'inherit' });
execSync('npm run build -w @browpilot/extension', { stdio: 'inherit' });

// 2. Fresh output dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/dist`, { recursive: true });

// 3. Bundle mcp + broker (shared inlined; heavy/native deps external).
await esbuild.build({
  entryPoints: ['packages/mcp-server/src/index.ts'],
  outfile: `${OUT}/dist/mcp.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: EXTERNAL, banner: { js: '#!/usr/bin/env node' },
});
await esbuild.build({
  entryPoints: ['packages/broker/src/index.ts'],
  outfile: `${OUT}/dist/broker.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['ws'],
});
chmodSync(`${OUT}/dist/mcp.js`, 0o755);

// 4. Copy the built extension.
cpSync('packages/extension/dist', `${OUT}/extension`, {
  recursive: true,
  filter: (src) => !src.endsWith('.map') && !src.endsWith('.tsbuildinfo'),
});

// 5. package.json — version from root, deps from mcp-server.
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const mcpPkg = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8'));
// Filter out workspace-internal packages (version "*" or "@browpilot/" scope):
// esbuild inlines them, so they are not runtime deps of the published package.
// Leaving them in would cause `npm install browpilot` to fail because those
// packages are private and never published to npm.
const publishDeps = Object.fromEntries(
  Object.entries(mcpPkg.dependencies ?? {}).filter(
    ([name, ver]) => ver !== '*' && !name.startsWith('@browpilot/'),
  ),
);
writeFileSync(
  `${OUT}/package.json`,
  JSON.stringify(makePackageManifest(root.version, publishDeps), null, 2) + '\n',
);
// 6. README for the npm page.
cpSync('docs/release-README.md', `${OUT}/README.md`);
cpSync('LICENSE', `${OUT}/LICENSE`);
console.log(`Assembled ${OUT}/ (Browpilot ${root.version})`);
