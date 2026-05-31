import { createHash } from 'node:crypto';

/**
 * Map the first 16 bytes of a SHA-256 digest to Chrome's extension-id
 * alphabet. Chrome takes the hex of the first 16 digest bytes and replaces
 * each hex digit 0..f with the letters a..p. Result is always 32 chars.
 */
export function computeExtensionId(publicKeyDer: Buffer): string {
  const digest = createHash('sha256').update(publicKeyDer).digest();
  const first16 = digest.subarray(0, 16);
  let id = '';
  for (const byte of first16) {
    // Each byte -> two hex nibbles -> two a..p letters.
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    id += String.fromCharCode(97 + hi);
    id += String.fromCharCode(97 + lo);
  }
  return id;
}

/**
 * Derive the pinned extension id from a manifest `key` field. The `key` is a
 * base64-encoded DER SubjectPublicKeyInfo; Chrome hashes those raw DER bytes.
 */
export function idFromManifestKey(manifestKey: string): string {
  if (!manifestKey || manifestKey.trim().length === 0) {
    throw new Error('manifest key is empty: cannot derive extension id');
  }
  const der = Buffer.from(manifestKey, 'base64');
  if (der.length === 0) {
    throw new Error('manifest key did not base64-decode to any bytes');
  }
  return computeExtensionId(der);
}
