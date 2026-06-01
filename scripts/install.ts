import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolvePaths } from './lib/paths.js';
import { ensureConfig } from './lib/ensure-config.js';
import { readPinnedExtensionId } from './lib/manifest.js';
import { run } from './lib/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

function log(msg: string): void {
  process.stdout.write(`[install] ${msg}\n`);
}

async function main(): Promise<void> {
  console.log('Dev install: registered local build. End users: claude mcp add claude-browser -- npx -y claude-browser');

  const paths = resolvePaths(REPO_ROOT, homedir());

  log(`Ensuring config at ${paths.configFile}...`);
  const extensionId = await readPinnedExtensionId(paths.extensionDist);
  const { created, config } = await ensureConfig(paths.configFile, extensionId);
  log(created ? `Created new config (port ${config.port}).` : `Config already exists (port ${config.port}).`);

  log('Registering MCP server with Claude Code...');
  // Remove any stale registration first so re-installs are idempotent.
  await run('claude', ['mcp', 'remove', 'claude-browser'], { allowFailure: true });
  await run('claude', ['mcp', 'add', 'claude-browser', '--', 'node', paths.mcpServerEntry]);
  log('Registered "claude-browser" MCP server.');

  process.stdout.write(
    [
      '',
      '============================================================',
      ' Dev install complete. Load the extension from:',
      `      ${paths.extensionDist}`,
      '============================================================',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[install] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
