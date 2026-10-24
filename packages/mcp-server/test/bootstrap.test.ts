import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idFromManifestKey, ensureConfig } from '../src/bootstrap.js';

describe('bootstrap', () => {
  it('idFromManifestKey returns a 32-char a-p id', () => {
    const id = idFromManifestKey(Buffer.from('any-der-bytes').toString('base64'));
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('ensureConfig writes config (port/token/extensionId) when absent, idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'cb-home-'));
    const extDir = mkdtempSync(join(tmpdir(), 'cb-ext-'));
    writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ key: Buffer.from('k').toString('base64') }));

    ensureConfig(extDir, home);
    const cfgPath = join(home, '.browpilot', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(cfg.port).toBe(8787);
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.extensionId).toMatch(/^[a-p]{32}$/);

    const token1 = cfg.token;
    ensureConfig(extDir, home); // idempotent — token unchanged
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).token).toBe(token1);
  });

  it('ensureConfig is a no-op (no extDir needed) when config already exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'cb-home2-'));
    mkdirSync(join(home, '.browpilot'), { recursive: true });
    const cfgPath = join(home, '.browpilot', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ port: 9999, token: 'x'.repeat(64), extensionId: 'a'.repeat(32) }));
    expect(() => ensureConfig(null, home)).not.toThrow();
    expect(JSON.parse(readFileSync(cfgPath, 'utf8')).port).toBe(9999);
  });

  it('repairs a config with an empty/invalid extensionId, preserving token + port', () => {
    const home = mkdtempSync(join(tmpdir(), 'cb-home3-'));
    const extDir = mkdtempSync(join(tmpdir(), 'cb-ext3-'));
    const key = Buffer.from('k2').toString('base64');
    writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ key }));
    const cfgDir = join(home, '.browpilot');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'config.json');
    const token = 'a1'.repeat(32); // 64 hex chars — a valid existing token
    writeFileSync(cfgPath, JSON.stringify({ port: 8899, token, extensionId: '' }));

    ensureConfig(extDir, home); // self-heal the empty id

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(cfg.extensionId).toBe(idFromManifestKey(key));
    expect(cfg.extensionId).toMatch(/^[a-p]{32}$/);
    expect(cfg.token).toBe(token); // preserved, not regenerated
    expect(cfg.port).toBe(8899); // preserved
  });
});
