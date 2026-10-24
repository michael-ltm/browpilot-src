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

  it('merges legacy entries into an existing ~/.browpilot without overwriting', () => {
    const home = mkdtempSync(join(tmpdir(), 'bp-home-'));
    mkdirSync(join(home, '.claude-browser', 'developer-profiles'), { recursive: true });
    writeFileSync(join(home, '.claude-browser', 'config.json'), '{"token":"old"}');
    writeFileSync(join(home, '.claude-browser', 'browser-profiles.json'), '{"legacy":true}');
    mkdirSync(join(home, '.browpilot', 'developer-profiles'), { recursive: true });
    writeFileSync(join(home, '.browpilot', 'browser-profiles.json'), '{"new":true}');
    expect(migrateLegacyConfigDir(home)).toBe(true);
    expect(readFileSync(join(home, '.browpilot', 'config.json'), 'utf8')).toBe('{"token":"old"}');
    expect(readFileSync(join(home, '.browpilot', 'browser-profiles.json'), 'utf8')).toBe('{"new":true}');
    expect(existsSync(join(home, '.claude-browser', 'browser-profiles.json'))).toBe(true);
  });

  it('removes the legacy dir once everything has moved', () => {
    const home = mkdtempSync(join(tmpdir(), 'bp-home-'));
    mkdirSync(join(home, '.claude-browser'));
    writeFileSync(join(home, '.claude-browser', 'config.json'), '{}');
    mkdirSync(join(home, '.browpilot'));
    expect(migrateLegacyConfigDir(home)).toBe(true);
    expect(existsSync(join(home, '.claude-browser'))).toBe(false);
  });

  it('is a no-op on a fresh machine', () => {
    const home = mkdtempSync(join(tmpdir(), 'bp-home-'));
    expect(migrateLegacyConfigDir(home)).toBe(false);
    expect(existsSync(join(home, '.browpilot'))).toBe(false);
  });
});
