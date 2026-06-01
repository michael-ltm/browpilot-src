import { describe, it, expect } from 'vitest';
import { tabsTools } from '../src/tools/tabs.js';
import { createContext } from '../src/context.js';
import { Method, ErrorCode } from '@claude-browser/shared';
import { RpcError } from '../src/client.js';
import { registerAll } from '../src/tools/index.js';

const getTabs = () => tabsTools.find((t) => t.name === 'browser_get_tabs')!;

describe('profile routing in existing tools', () => {
  it('injects selectedBrowserId into the request params', async () => {
    const calls: any[] = [];
    const ctx = createContext({ request: async (m: string, p?: unknown) => { calls.push([m, p]); return { tabs: [] }; } });
    ctx.selectedBrowserId = 'b9';
    await getTabs().handler({}, ctx);
    expect(calls[0][0]).toBe(Method.GET_TABS);
    expect(calls[0][1]).toMatchObject({ browserId: 'b9' });
  });

  it('explicit profile arg overrides the selection', async () => {
    const calls: any[] = [];
    const ctx = createContext({ request: async (_m: string, p?: unknown) => { calls.push(p); return { tabs: [] }; } });
    ctx.selectedBrowserId = 'b9';
    await getTabs().handler({ profile: 'other' }, ctx);
    expect(calls[0]).toMatchObject({ browserId: 'other' });
  });

  it('registerAll converts AMBIGUOUS_PROFILE into a non-fatal guidance result', async () => {
    const tools = new Map<string, (a: any, c: any) => Promise<any>>();
    const sink = { registerTool(name: string, _cfg: unknown, h: (a: any, c: any) => Promise<any>) { tools.set(name, h); } };
    const ctx = createContext({
      request: async () => { throw new RpcError(ErrorCode.AMBIGUOUS_PROFILE, 'ambiguous', { profiles: [{ browserId: 'a', label: 'A', status: 'connected', reconnectCount: 0, tabCount: 0 }] }); },
    });
    registerAll(sink as any, ctx);
    const res = await tools.get('browser_get_tabs')!({}, ctx);
    expect(JSON.stringify(res.content)).toContain('browser_select_profile');
    expect(res.isError).toBeFalsy();
  });
});
