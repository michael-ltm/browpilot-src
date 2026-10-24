import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT, type Config } from '@claude-browser/shared';
import { withReleaseDefaults } from './release-config.js';

/** Absolute path to the broker config file. `home` is injectable for tests. */
export function configPath(home: string = homedir()): string {
  return join(home, CONFIG_DIR, CONFIG_FILE);
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function isConfig(value: unknown): value is Config {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.port === 'number' &&
    typeof c.token === 'string' &&
    c.token.length > 0 &&
    typeof c.extensionId === 'string' &&
    c.extensionId.length > 0
  );
}

/**
 * Create the config (token + DEFAULT_PORT + extensionId) if it does not exist.
 * Idempotent: an existing config is returned untouched so the token is stable.
 */
export function ensureConfig(extensionId: string, home: string = homedir()): Config {
  const path = configPath(home);
  if (existsSync(path)) {
    return withReleaseDefaults(loadRaw(path));
  }
  mkdirSync(join(home, CONFIG_DIR), { recursive: true });
  const cfg: Config = withReleaseDefaults({ port: DEFAULT_PORT, token: generateToken(), extensionId });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  return cfg;
}

function loadRaw(path: string): Config {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isConfig(parsed)) {
    throw new Error(`Invalid config at ${path}`);
  }
  return parsed;
}

/**
 * Load and validate the config, applying a numeric CLAUDE_BROKER_PORT override.
 * Throws if the file is absent or malformed.
 */
export function loadConfig(home: string = homedir()): Config {
  const path = configPath(home);
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}; run install first`);
  }
  const cfg = withReleaseDefaults(loadRaw(path));
  const override = process.env.CLAUDE_BROKER_PORT;
  if (override !== undefined) {
    const port = Number(override);
    if (Number.isInteger(port) && port > 0) {
      return { ...cfg, port };
    }
  }
  return cfg;
}
