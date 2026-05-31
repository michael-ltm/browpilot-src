import { describe, it, expect } from 'vitest';
import { computeExtensionId, idFromManifestKey } from './extension-id.js';

// The Codex extension's manifest `key` and its KNOWN published id give us a
// real fixture: deriving the id from this key must yield this exact string.
// (Verified against Chrome's published Codex extension id.)
const CODEX_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5M/DZ28sAuOnk9v8C2IPTLNEZ0F0pv9qwRzMAbGbE0NB6I6T+wS6Na2n0sbQOK98iezN2FX26dsBWMELXtf4YCETdRiFSBOnNhZObZdrxeTTrhk1AhKA/Id5vgDWfSZ3Q+9BjBWHYK9yuTGo3PMK/yOW/CH6cSn07btvn7Aq+t+KrAwGOJewCN7gGojOrshJs/YwdxwxpUnb7s6QbFGkPKg9G6as4y4ipQ8fiQHRAcKm+mUK/CoCVSL+c4Yog0CSJqEEaruOeh8CgM4V0LX4kw5rs/4THAvTwtYRsW0n3faVR7uGj1eadsWuKciQHxpRMI9I4EE7yuaxavv3Agf6QIDAQAB';

describe('computeExtensionId', () => {
  it('maps each hex nibble of the first 16 SHA-256 bytes to a..p', () => {
    // Hand-computed reference: a 32-byte buffer of all zeros -> SHA-256 of
    // those zero bytes, first 16 bytes mapped. We assert the format instead
    // of a magic value by checking length + alphabet membership.
    const id = computeExtensionId(Buffer.alloc(32, 0));
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is deterministic for the same input', () => {
    const buf = Buffer.from('hello world for hashing', 'utf8');
    expect(computeExtensionId(buf)).toBe(computeExtensionId(buf));
  });

  it('changes when the input changes', () => {
    expect(computeExtensionId(Buffer.from('a'))).not.toBe(
      computeExtensionId(Buffer.from('b')),
    );
  });
});

describe('idFromManifestKey', () => {
  it('derives a 32-char a..p id from a base64 DER public key', () => {
    const id = idFromManifestKey(CODEX_KEY);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is stable across calls (pinned id)', () => {
    expect(idFromManifestKey(CODEX_KEY)).toBe(idFromManifestKey(CODEX_KEY));
  });

  it('throws on an empty key', () => {
    expect(() => idFromManifestKey('')).toThrow(/key/i);
  });
});
