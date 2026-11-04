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

/**
 * The broker is often started by an agent process that has no desktop session
 * variables, and a browser started without them exits at once ("Failed to
 * connect to Wayland display") or cannot reach the keyring that encrypts its
 * cookies. On Linux, fill in only what is missing from the user's runtime dir.
 */
export function graphicalEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
  fs: { exists: (p: string) => boolean; list: (p: string) => string[] } = { exists: existsSync, list: p => { try { return readdirSync(p); } catch { return []; } } },
): NodeJS.ProcessEnv {
  if (platform !== 'linux') return env;
  const out = { ...env };
  const runtime = out.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);
  if (!runtime || !fs.exists(runtime)) return out;
  out.XDG_RUNTIME_DIR = runtime;
  if (!out.WAYLAND_DISPLAY && !out.DISPLAY) {
    const wayland = fs.list(runtime).filter(n => /^wayland-\d+$/.test(n)).sort()[0];
    const x11 = fs.list('/tmp/.X11-unix').filter(n => /^X\d+$/.test(n)).sort()[0];
    if (wayland) out.WAYLAND_DISPLAY = wayland;
    if (x11) out.DISPLAY = ':' + x11.slice(1);
  }
  if (!out.DBUS_SESSION_BUS_ADDRESS && fs.exists(join(runtime, 'bus'))) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(runtime, 'bus')}`;
  return out;
}
