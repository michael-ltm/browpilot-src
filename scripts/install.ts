import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { resolvePaths } from './lib/paths.js';
import { readPinnedExtensionId } from './lib/manifest.js';
import { ensureConfig } from './lib/ensure-config.js';
import { run } from './lib/run.js';
import { renderLaunchdPlist } from '@claude-browser/broker';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

function log(msg: string): void {
  process.stdout.write(`[install] ${msg}\n`);
}

async function main(): Promise<void> {
  const paths = resolvePaths(REPO_ROOT, homedir());

  log('Building all packages...');
  await run('npm', ['run', 'build'], { cwd: REPO_ROOT });

  log('Deriving pinned extension id from built manifest...');
  const extensionId = await readPinnedExtensionId(paths.extensionDist);
  log(`Pinned extension id: ${extensionId}`);

  log(`Ensuring config at ${paths.configFile}...`);
  const { created, config } = await ensureConfig(paths.configFile, extensionId);
  log(created ? `Created new config (port ${config.port}).` : `Updated existing config (port ${config.port}, token preserved).`);

  log('Rendering launchd plist...');
  const plist = renderLaunchdPlist({
    nodePath: process.execPath,
    scriptPath: paths.brokerEntry,
  });
  await writeFile(paths.plistPath, plist, 'utf8');
  log(`Wrote ${paths.plistPath}`);

  // Unload any previous instance (ignore failure on first install), then load.
  await run('launchctl', ['unload', paths.plistPath], { allowFailure: true });
  await run('launchctl', ['load', paths.plistPath]);
  log('Broker launchd agent loaded (KeepAlive, RunAtLoad).');

  log('Registering MCP server with Claude Code...');
  // Remove any stale registration first so re-installs are idempotent.
  await run('claude', ['mcp', 'remove', 'claude-browser'], { allowFailure: true });
  await run('claude', ['mcp', 'add', 'claude-browser', '--', 'node', paths.mcpServerEntry]);
  log('Registered "claude-browser" MCP server.');

  process.stdout.write(
    [
      '',
      '============================================================',
      ' Almost done — load the Chrome extension (one-time, manual):',
      '============================================================',
      ' 1. Open chrome://extensions',
      ' 2. Enable "Developer mode" (top-right toggle)',
      ' 3. Click "Load unpacked" and select:',
      `      ${paths.extensionDist}`,
      ' 4. Confirm the loaded extension ID equals:',
      `      ${extensionId}`,
      '    (If it differs, the broker will reject it — rebuild the',
      '     extension and re-run install.)',
      '',
      ' The broker is now running and will stay up across reboots.',
      ' Start a new Claude Code session to use the browser_* tools.',
      '============================================================',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[install] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
