import { describe, expect, it } from 'vitest';
import { pairRequest, pairingNonce } from '../src/background/pairing';

describe('profile pairing', () => {
  it('recognizes our completed cold-start pairing tab and ignores unrelated tabs', () => {
    const nonce = 'a'.repeat(32);
    expect(pairingNonce(`chrome-extension://ours/pair.html#${nonce}`, 'ours')).toBe(nonce);
    expect(pairingNonce(`chrome-extension://theirs/pair.html#${nonce}`, 'ours')).toBeNull();
    expect(pairingNonce('https://example.com/#' + nonce, 'ours')).toBeNull();
  });
  it('accepts a nonce only from our own pairing page', async () => {
    const call = async () => ({ paired: true });
    const sender = { id: 'our-id', url: 'chrome-extension://our-id/pair.html#abc' };
    expect(await pairRequest({ type: 'browpilot-pair', nonce: 'a'.repeat(32) }, sender, 'our-id', call)).toEqual({ paired: true });
    await expect(pairRequest({ type: 'browpilot-pair', nonce: 'a'.repeat(32) }, { ...sender, url: 'https://evil.example' }, 'our-id', call)).rejects.toThrow(/pairing page/);
  });
  it('rejects malformed nonces', async () => {
    await expect(pairRequest({ type: 'browpilot-pair', nonce: '../x' }, { id: 'our-id', url: 'chrome-extension://our-id/pair.html' }, 'our-id', async () => ({}))).rejects.toThrow(/nonce/);
  });
});
