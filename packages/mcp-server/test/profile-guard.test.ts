import { describe, expect, it } from 'vitest';
import { guardProfile, acceptProfileResult } from '../src/profile-guard.js';
import { createContext } from '../src/context.js';

describe('per-session profile generations', () => {
  it('refuses stale tab mutation after another session restarts the browser', async () => {
    let generation = 1;
    const ctx = createContext({ request: async () => ({ profiles: [{ browserId: 'b', status: 'connected', connectedAt: generation, reconnectCount: generation }] }) as never });
    ctx.selectedBrowserId = 'b';
    await guardProfile('browser_get_tabs', {}, ctx);
    ctx.refs.set('ref1', 5); generation++;
    await expect(guardProfile('browser_close_tab', { tabId: 5 }, ctx)).rejects.toThrow(/fresh/);
    expect(ctx.refs.size).toBe(0);
  });
  it('keeps stale tab actions blocked until tabs are refreshed', async () => {
    let generation = 1;
    const ctx = createContext({ request: async () => ({ profiles: [{ browserId: 'b', status: 'connected', connectedAt: generation }] }) as never });
    ctx.selectedBrowserId = 'b';
    await guardProfile('browser_get_tabs', {}, ctx); generation++;
    await expect(guardProfile('browser_close_tab', { tabId: 5 }, ctx)).rejects.toThrow(/fresh/);
    await expect(guardProfile('browser_close_tab', { tabId: 5 }, ctx)).rejects.toThrow(/fresh/);
    const checked = await guardProfile('browser_get_tabs', {}, ctx);
    await expect(guardProfile('browser_close_tab', { tabId: 7 }, ctx)).rejects.toThrow(/fresh/);
    acceptProfileResult('browser_get_tabs', checked, ctx);
    await expect(guardProfile('browser_close_tab', { tabId: 7 }, ctx)).resolves.toEqual({ tabId: 7 });
  });
  it('updates selected runtime ID after verified re-pairing', async () => {
    const ctx = createContext({ request: async (method: string) => {
      if (method === 'listProfiles') return { profiles: [] } as never;
      if (method === 'ensureLocalInstance') return { browserId: 'new', launched: true } as never;
      return {} as never;
    } });
    ctx.selectedBrowserId = 'old';
    await guardProfile('browser_get_tabs', {}, ctx);
    expect(ctx.selectedBrowserId).toBe('new');
  });
});
