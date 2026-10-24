import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, LEGACY_CONFIG_DIR } from './protocol.js';

/**
 * Move a pre-rename `~/.claude-browser` directory to `~/.browpilot` so the
 * token, port, profile catalog and developer profiles survive the rename.
 * When `~/.browpilot` already exists (something created a subdirectory before
 * the first start), legacy entries it does not have yet are moved into it;
 * entries already present in `~/.browpilot` win. Returns true if anything moved.
 * Node-only, so it lives outside the browser-safe package entry.
 */
export function migrateLegacyConfigDir(home: string = homedir()): boolean {
  const target = join(home, CONFIG_DIR);
  const legacy = join(home, LEGACY_CONFIG_DIR);
  if (!existsSync(legacy)) return false;
  try {
    if (!existsSync(target)) {
      renameSync(legacy, target);
      return true;
    }
    let moved = false;
    for (const entry of readdirSync(legacy)) {
      if (existsSync(join(target, entry))) continue;
      renameSync(join(legacy, entry), join(target, entry));
      moved = true;
    }
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
    return moved;
  } catch {
    // Another process (broker vs MCP server) raced us; whatever it moved is already in place.
    return false;
  }
}
