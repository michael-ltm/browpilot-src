import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPinnedExtensionId } from './manifest.js';
import { idFromManifestKey } from './extension-id.js';

const CODEX_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5M/DZ28sAuOnk9v8C2IPTLNEZ0F0pv9qwRzMAbGbE0NB6I6T+wS6Na2n0sbQOK98iezN2FX26dsBWMELXtf4YCETdRiFSBOnNhZObZdrxeTTrhk1AhKA/Id5vgDWfSZ3Q+9BjBWHYK9yuTGo3PMK/yOW/CH6cSn07btvn7Aq+t+KrAwGOJewCN7gGojOrshJs/YwdxwxpUnb7s6QbFGkPKg9G6as4y4ipQ8fiQHRAcKm+mUK/CoCVSL+c4Yog0CSJqEEaruOeh8CgM4V0LX4kw5rs/4THAvTwtYRsW0n3faVR7uGj1eadsWuKciQHxpRMI9I4EE7yuaxavv3Agf6QIDAQAB';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-manifest-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readPinnedExtensionId', () => {
  it('reads the key from a dist manifest and derives the id', async () => {
    const distDir = join(dir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'x', key: CODEX_KEY }),
      'utf8',
    );
    const id = await readPinnedExtensionId(distDir);
    expect(id).toBe(idFromManifestKey(CODEX_KEY));
  });

  it('throws a build-hint error when manifest.json is missing', async () => {
    await expect(readPinnedExtensionId(join(dir, 'nope'))).rejects.toThrow(
      /build the extension/i,
    );
  });

  it('throws when the manifest has no key field', async () => {
    const distDir = join(dir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'x' }),
      'utf8',
    );
    await expect(readPinnedExtensionId(distDir)).rejects.toThrow(/key/i);
  });
});
