import { describe, it, expect, vi } from 'vitest';
import { Router } from '../src/router.js';
import { ProfileRegistry } from '../src/profiles.js';
import { ErrorCode, Method, Notif, type JsonRpcMessage, type JsonRpcRequest } from '@claude-browser/shared';

function setup() {
  const registry = new ProfileRegistry();
  const router = new Router(registry);
  const browserSends: Record<string, JsonRpcMessage[]> = {};
  const agentSends: JsonRpcMessage[] = [];
  function connectBrowser(id: string, label = id) {
    browserSends[id] = [];
    registry.connected(id, label);
    router.registerBrowser(id, (m) => browserSends[id]!.push(m));
  }
  router.registerAgent('s1', (m) => agentSends.push(m));
  const lastFwd = (id: string) => browserSends[id]!.filter((m) => 'method' in m && 'id' in m).at(-1) as JsonRpcRequest;
  return { registry, router, browserSends, agentSends, connectBrowser, lastFwd };
}

describe('Router multi-browser routing', () => {
  it('auto-routes to the sole connected profile when browserId is omitted', async () => {
    const t = setup(); t.connectBrowser('a');
    const p = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 7, method: Method.GET_TABS, params: {} });
    const fwd = t.lastFwd('a');
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', id: fwd.id, result: { tabs: [] } });
    expect(await p).toEqual({ jsonrpc: '2.0', id: 7, result: { tabs: [] } });
  });

  it('returns AMBIGUOUS_PROFILE with the candidate list when >1 connected and none specified', async () => {
    const t = setup(); t.connectBrowser('a', 'A'); t.connectBrowser('b', 'B');
    const res = (await t.router.routeRequest('s1', { jsonrpc: '2.0', id: 1, method: Method.GET_TABS, params: {} })) as any;
    expect(res.error.code).toBe(ErrorCode.AMBIGUOUS_PROFILE);
    expect(res.error.data.profiles.map((p: any) => p.browserId).sort()).toEqual(['a', 'b']);
  });

  it('routes to the named profile when browserId is given', async () => {
    const t = setup(); t.connectBrowser('a'); t.connectBrowser('b');
    const p = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 2, method: Method.GET_TABS, params: { browserId: 'b' } });
    expect(t.browserSends['a']!.length).toBe(0);
    const fwd = t.lastFwd('b');
    t.router.handleBrowserMessage('b', { jsonrpc: '2.0', id: fwd.id, result: { tabs: [] } });
    await p;
    expect(t.browserSends['b']!.length).toBe(1);
  });

  it('serves listProfiles locally', async () => {
    const t = setup(); t.connectBrowser('a', 'A');
    const res = (await t.router.routeRequest('s1', { jsonrpc: '2.0', id: 3, method: Method.LIST_PROFILES, params: {} })) as any;
    expect(res.result.profiles[0]).toMatchObject({ browserId: 'a', label: 'A', status: 'connected' });
  });

  it('answers a browser-originated ping with {pong:true}', () => {
    const t = setup(); t.connectBrowser('a');
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', id: 99, method: Method.PING });
    expect(t.browserSends['a']!.at(-1)).toEqual({ jsonrpc: '2.0', id: 99, result: { pong: true } });
  });

  it('isolates disconnect: only the dropped profile\'s pending rejects', async () => {
    const t = setup(); t.connectBrowser('a'); t.connectBrowser('b');
    const pa = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 10, method: Method.GET_TABS, params: { browserId: 'a' } });
    const pb = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 11, method: Method.GET_TABS, params: { browserId: 'b' } });
    t.router.onBrowserDisconnect('a');
    expect((await pa as any).error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);
    const fwdB = t.lastFwd('b');
    t.router.handleBrowserMessage('b', { jsonrpc: '2.0', id: fwdB.id, result: { tabs: [] } });
    expect((await pb as any).result).toEqual({ tabs: [] });
    // an onProfileChange was broadcast for 'a'
    expect(t.agentSends.some((m) => 'method' in m && m.method === Notif.ON_PROFILE_CHANGE)).toBe(true);
  });

  it('leases are per (browserId, tabId): same tabId on different profiles does not collide', async () => {
    const t = setup(); t.connectBrowser('a'); t.connectBrowser('b');
    const pa = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 20, method: Method.ATTACH, params: { tabId: 1, browserId: 'a' } });
    const pb = t.router.routeRequest('s2DifferentSession', { jsonrpc: '2.0', id: 21, method: Method.ATTACH, params: { tabId: 1, browserId: 'b' } });
    // neither is LEASE_DENIED (different browsers)
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', id: t.lastFwd('a').id, result: {} });
    t.router.handleBrowserMessage('b', { jsonrpc: '2.0', id: t.lastFwd('b').id, result: {} });
    expect((await pa as any).result).toEqual({});
    expect((await pb as any).result).toEqual({});
  });

  it('tags browser notifications with browserId before broadcasting to agents', () => {
    const t = setup(); t.connectBrowser('a');
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', method: Notif.ON_CDP_EVENT, params: { source: { tabId: 1 }, method: 'Page.loadEventFired', params: {} } });
    const note = t.agentSends.find((m) => 'method' in m && m.method === Notif.ON_CDP_EVENT) as any;
    expect(note.params.browserId).toBe('a');
  });
});
