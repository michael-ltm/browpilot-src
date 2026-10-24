import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyConfigDir } from '../src/node.js';

describe('migrateLegacyConfigDir', () => {
  it('moves ~/.claude-browser to ~/.browpilot when only the legacy dir exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'bp-home-'));
    mkdirSync(join(home, '.claude-browser'));
    writeFileSync(join(home, '.claude-browser', 'config.json'), '{"token":"t"}');
    expect(migrateLegacyConfigDir(home)).toBe(true);
    expect(readFileSync(join(home, '.browpilot', 'config.json'), 'utf8')).toBe('{"token":"t"}');
    expect(existsSync(join(home, '.claude-browser'))).toBe(false);
  });

  it('leaves both dirs alone when ~/.browpilot already exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'bp-home-'));
    mkdirSync(join(home, '.claude-browser'));
    mkdirSync(join(home, '.browpilot'));
    expect(migrateLegacyConfigDir(home)).toBe(false);
    expect(existsSync(join(home, '.claude-browser'))).toBe(true);
  });

  it('is a no-op on a fresh machine', () => {
    const home = mkdtempSync(join(tmpdir(), 'bp-home-'));
    expect(migrateLegacyConfigDir(home)).toBe(false);
    expect(existsSync(join(home, '.browpilot'))).toBe(false);
  });
});
