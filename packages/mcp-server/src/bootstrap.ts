import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT, type Config } from '@claude-browser/shared';

/**
 * Chrome extension id from a manifest `key` (base64-encoded DER SubjectPublicKeyInfo):
 * the first 16 SHA-256 bytes, each hex digit 0..f mapped to letters a..p (32 chars).
 */
export function idFromManifestKey(manifestKey: string): string {
  const der = Buffer.from(manifestKey, 'base64');
  if (der.length === 0) throw new Error('claude-browser: extension manifest key did not decode');
  const digest = createHash('sha256').update(der).digest().subarray(0, 16);
  let id = '';
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/**
 * First-run bootstrap for the npx / standalone flow: create
 * ~/.claude-browser/config.json (DEFAULT_PORT + a random token + an extensionId
 * derived from the bundled extension manifest `key`) if it does not already
 * exist. Idempotent — an existing config is left untouched so the token stays
 * stable. When the config already exists, `extensionDir` is not needed.
 */
export function ensureConfig(extensionDir: string | null, home: string = homedir()): void {
  const path = join(home, CONFIG_DIR, CONFIG_FILE);
  if (existsSync(path)) return;
  if (!extensionDir) {
    throw new Error(
      'claude-browser: bundled extension not found, cannot derive extensionId. ' +
        'Run from the published package, or build the extension (npm run build -w @claude-browser/extension).',
    );
  }
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')) as { key?: string };
  if (!manifest.key) {
    throw new Error('claude-browser: extension manifest has no "key"; cannot pin the extension id');
  }
  const cfg: Config = {
    port: DEFAULT_PORT,
    token: randomBytes(32).toString('hex'),
    extensionId: idFromManifestKey(manifest.key),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}
