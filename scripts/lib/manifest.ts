import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { idFromManifestKey } from './extension-id.js';

interface PartialManifest {
  key?: string;
}

/**
 * Read packages/extension/dist/manifest.json and derive the pinned extension
 * id from its `key`. Throws an actionable error if the extension has not been
 * built or the manifest lacks a pinning key.
 */
export async function readPinnedExtensionId(distDir: string): Promise<string> {
  const manifestPath = join(distDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Extension manifest not found at ${manifestPath}. Build the extension first ` +
        `(npm run build -w @browpilot/extension).`,
    );
  }
  const manifest = JSON.parse(raw) as PartialManifest;
  if (!manifest.key) {
    throw new Error(
      `Extension manifest at ${manifestPath} has no "key" field; the id cannot be pinned.`,
    );
  }
  return idFromManifestKey(manifest.key);
}
