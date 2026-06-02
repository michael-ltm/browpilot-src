import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureConfig } from './ensure-config.js';
import { DEFAULT_PORT, type Config } from '@claude-browser/shared';

let dir: string;
let configFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-cfg-'));
  configFile = join(dir, '.claude-browser', 'config.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(): Promise<Config> {
  return JSON.parse(await readFile(configFile, 'utf8')) as Config;
}

describe('ensureConfig', () => {
  it('creates a fresh config with default port, a hex token and the pinned id', async () => {
    const result = await ensureConfig(configFile, 'abcdefghijklmnopabcdefghijklmnop');
    expect(result.created).toBe(true);
    const cfg = await read();
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.extensionId).toBe('abcdefghijklmnopabcdefghijklmnop');
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex
  });

  it('preserves existing token and port but refreshes extensionId', async () => {
    await mkdir(join(dir, '.claude-browser'), { recursive: true });
    const existing: Config = { port: 9999, token: 'deadbeef'.repeat(8), extensionId: 'oldoldoldoldoldoldoldoldoldoldol' };
    await writeFile(configFile, JSON.stringify(existing), 'utf8');

    const result = await ensureConfig(configFile, 'newnewnewnewnewnewnewnewnewnewne');
    expect(result.created).toBe(false);
    const cfg = await read();
    expect(cfg.port).toBe(9999);
    expect(cfg.token).toBe('deadbeef'.repeat(8));
    expect(cfg.extensionId).toBe('newnewnewnewnewnewnewnewnewnewne');
  });

  // POSIX-only: Windows has no 0600 mode bits, so skip the permission assertion there.
  it.skipIf(process.platform === 'win32')('writes config with 0600 permissions (user-only readable)', async () => {
    await ensureConfig(configFile, 'abcdefghijklmnopabcdefghijklmnop');
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(configFile)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
