import { describe, expect, it } from 'vitest';
import { pairRequest, pairingNonce, sendUntilReceived } from '../src/background/pairing';

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

describe('sendUntilReceived', () => {
  it('retries while the worker has no listener yet, then returns the reply', async () => {
    let calls = 0;
    const result = await sendUntilReceived(async () => {
      if (++calls < 3) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { paired: true };
    }, 1000, 1);
    expect(result).toEqual({ paired: true });
    expect(calls).toBe(3);
  });

  it('does not retry other failures', async () => {
    let calls = 0;
    await expect(sendUntilReceived(async () => { calls++; throw new Error('Invalid pairing nonce'); }, 1000, 1)).rejects.toThrow('Invalid pairing nonce');
    expect(calls).toBe(1);
  });
});
