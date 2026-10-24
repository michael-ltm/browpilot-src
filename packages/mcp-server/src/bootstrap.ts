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

const EXT_ID_RE = /^[a-p]{32}$/;

/** Derive the pinned extension id from the bundled extension's manifest `key`, or null when unavailable. */
function deriveExtensionId(extensionDir: string | null): string | null {
  if (!extensionDir) return null;
  const manifestPath = join(extensionDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string };
    return manifest.key ? idFromManifestKey(manifest.key) : null;
  } catch {
    return null;
  }
}

/**
 * First-run + self-healing bootstrap for the npx / standalone flow. Ensures
 * ~/.claude-browser/config.json exists AND stays consistent with the bundled
 * extension:
 *   - missing or corrupt config        → written fresh
 *   - empty / invalid / mismatched id   → repaired (id re-derived from the
 *                                         bundled manifest), preserving a valid
 *                                         existing port + token
 *   - already correct                   → left untouched (token stays stable)
 *
 * The extension id MUST match the bundled extension, otherwise the broker pins
 * the wrong Origin and the extension can never connect — a stale config with an
 * empty/wrong id is the classic "stuck reconnecting / -32000 ConnectionClosed"
 * failure (loadConfig throws on an empty id, crashing the MCP server).
 */
export function ensureConfig(extensionDir: string | null, home: string = homedir()): void {
  const path = join(home, CONFIG_DIR, CONFIG_FILE);
  const derivedId = deriveExtensionId(extensionDir);

  let existing: Partial<Config> | null = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    } catch {
      existing = null; // corrupt JSON → rewrite from scratch
    }
  }

  const hasToken = typeof existing?.token === 'string' && existing.token.length > 0;
  const hasPort = typeof existing?.port === 'number' && Number.isInteger(existing.port);
  const existingId =
    typeof existing?.extensionId === 'string' && EXT_ID_RE.test(existing.extensionId)
      ? existing.extensionId
      : null;

  // Healthy and consistent with the bundled extension → leave it untouched.
  if (existing && hasToken && hasPort && existingId && (derivedId === null || existingId === derivedId)) {
    return;
  }

  // Otherwise (re)write. The id comes from the bundled manifest, or from a still
  // valid existing id when there is no bundled extension to derive from.
  const extensionId = derivedId ?? existingId;
  if (!extensionId) {
    throw new Error(
      'claude-browser: bundled extension not found and config has no valid extensionId — ' +
        'cannot pin the extension id. Run from the published package, or build the extension ' +
        '(npm run build -w @claude-browser/extension).',
    );
  }

  const cfg: Config = {
    ...existing,
    port: hasPort ? (existing!.port as number) : DEFAULT_PORT,
    token: hasToken ? (existing!.token as string) : randomBytes(32).toString('hex'),
    extensionId,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}
