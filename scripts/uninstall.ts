import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { resolvePaths } from './lib/paths.js';
import { run } from './lib/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

function log(msg: string): void {
  process.stdout.write(`[uninstall] ${msg}\n`);
}

async function main(): Promise<void> {
  const paths = resolvePaths(REPO_ROOT, homedir());
  const purge = process.argv.includes('--purge');

  log('Unloading broker launchd agent...');
  await run('launchctl', ['unload', paths.plistPath], { allowFailure: true });
  await rm(paths.plistPath, { force: true });
  log(`Removed ${paths.plistPath}`);

  log('Removing MCP server registration...');
  await run('claude', ['mcp', 'remove', 'claude-browser'], { allowFailure: true });

  if (purge) {
    log(`Purging config dir ${paths.configDir} (--purge)...`);
    await rm(paths.configDir, { recursive: true, force: true });
  } else {
    log(`Keeping config at ${paths.configFile} (pass --purge to delete the token).`);
  }

  process.stdout.write(
    [
      '',
      ' Uninstall complete. To finish, manually remove the unpacked',
      ' extension at chrome://extensions (Chrome has no CLI for this).',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[uninstall] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
