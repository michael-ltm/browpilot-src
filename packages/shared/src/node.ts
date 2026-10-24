import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, LEGACY_CONFIG_DIR } from './protocol.js';

/**
 * Move a pre-rename `~/.claude-browser` directory to `~/.browpilot` so the
 * token, port, profile catalog and developer profiles survive the rename.
 * No-op when the new directory already exists or there is nothing to move.
 * Node-only, so it lives outside the browser-safe package entry.
 */
export function migrateLegacyConfigDir(home: string = homedir()): boolean {
  const target = join(home, CONFIG_DIR);
  const legacy = join(home, LEGACY_CONFIG_DIR);
  if (existsSync(target) || !existsSync(legacy)) return false;
  try {
    renameSync(legacy, target);
    return true;
  } catch {
    // Another process (broker vs MCP server) won the race; either way the new dir is in place.
    return false;
  }
}
