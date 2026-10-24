import { describe, it, expect } from 'vitest';
import { instanceTools } from '../src/tools/instances.js';
import { createContext } from '../src/context.js';
import { Method } from '@browpilot/shared';

describe('instance tools', () => {
  it('selects the paired browser and clears stale snapshot references after launch', async () => {
    const ctx = createContext({ request: async () => ({ browserId: 'paired', launched: true }) as never });
    ctx.refs.set('ref1', 12);
    await instanceTools.find(t => t.name === 'browser_open_instance')!.handler({ id: 'local-1' }, ctx);
    expect(ctx.selectedBrowserId).toBe('paired'); expect(ctx.refs.size).toBe(0);
  });
  it('exposes install guidance as a tool rather than claiming silent installation', () => {
    expect(instanceTools.find(t => t.name === 'browser_install_extension')!.description).toMatch(/confirm/i);
  });
  it('routes an id without allowRestart to the broker store-page flow', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const ctx = createContext({ request: async (method: string, params?: unknown) => { calls.push({ method, params }); return { url: 'x' } as never; } });
    await instanceTools.find(t => t.name === 'browser_install_extension')!.handler({ id: 'local-1' }, ctx);
    expect(calls).toEqual([{ method: Method.INSTALL_LOCAL_EXTENSION, params: { id: 'local-1' } }]);
  });
  it('rejects a controlled relaunch for an unknown local id', async () => {
    const ctx = createContext({ request: async () => ({ profiles: [] }) as never }, { extensionId: 'a'.repeat(32), extensionDir: '/ext' });
    const res = await instanceTools.find(t => t.name === 'browser_install_extension')!.handler({ id: 'nope', allowRestart: true }, ctx);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('browser_list_instances');
  });
});
