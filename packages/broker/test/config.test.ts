import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT } from '@claude-browser/shared';
import { loadConfig, ensureConfig, configPath } from '../src/config.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cb-config-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDE_BROKER_PORT;
});

describe('configPath', () => {
  it('resolves under CONFIG_DIR/CONFIG_FILE', () => {
    expect(configPath(home)).toBe(join(home, CONFIG_DIR, CONFIG_FILE));
  });
});

describe('ensureConfig', () => {
  it('creates a config with DEFAULT_PORT, a 64-hex token, and the given extensionId', () => {
    const cfg = ensureConfig('abcdefghabcdefghabcdefghabcdefgh', home);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.extensionId).toBe('abcdefghabcdefghabcdefghabcdefgh');
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(configPath(home))).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath(home), 'utf8'));
    expect(onDisk).toEqual(cfg);
  });

  it('is idempotent: a second call returns the same persisted config (same token)', () => {
    const first = ensureConfig('extid-one', home);
    const second = ensureConfig('extid-two', home);
    expect(second).toEqual(first);
    expect(second.extensionId).toBe('extid-one');
  });
});

describe('loadConfig', () => {
  it('throws when the config file is absent', () => {
    expect(() => loadConfig(home)).toThrow(/not found/i);
  });

  it('reads a persisted config', () => {
    const written = ensureConfig('extid-load', home);
    expect(loadConfig(home)).toEqual(written);
  });

  it('rejects a config missing required fields', () => {
    mkdirSync(join(home, CONFIG_DIR), { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ port: 8787 }), 'utf8');
    expect(() => loadConfig(home)).toThrow(/invalid config/i);
  });

  it('applies CLAUDE_BROKER_PORT override as a number', () => {
    ensureConfig('extid-port', home);
    process.env.CLAUDE_BROKER_PORT = '9999';
    expect(loadConfig(home).port).toBe(9999);
  });

  it('ignores a non-numeric CLAUDE_BROKER_PORT override', () => {
    const written = ensureConfig('extid-port2', home);
    process.env.CLAUDE_BROKER_PORT = 'not-a-number';
    expect(loadConfig(home).port).toBe(written.port);
  });
});
