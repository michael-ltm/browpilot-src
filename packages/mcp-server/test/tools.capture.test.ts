import { describe, it, expect, beforeEach } from 'vitest';
import { Method } from '@claude-browser/shared';
import { powerTools } from '../src/tools/power.js';
import { networkTools } from '../src/tools/network.js';
import { sourcesTools } from '../src/tools/sources.js';
import { debuggerTools } from '../src/tools/debugger.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import type { ToolDef, ToolResult } from '../src/tools/types.js';

function pick(list: ToolDef[], name: string): ToolDef {
  const t = list.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
const textOf = (r: ToolResult) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const innerMethod = (c: { params: unknown }) => (c.params as { method?: string })?.method;

describe('capture / power tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_cdp passes the raw method through and returns its JSON result', async () => {
    client.onCdp('Storage.getCookies', { cookies: [{ name: '_m_h5_tk' }] });
    const r = await pick(powerTools, 'browser_cdp').handler({ method: 'Storage.getCookies', tabId: 5 } as never, ctx);
    expect(client.cdpCalls()[0]!.method).toBe('Storage.getCookies');
    expect(textOf(r)).toContain('_m_h5_tk');
  });

  it('browser_events: subscribe echoes prefixes; poll truncates long payloads', async () => {
    client.onMethod(Method.SUBSCRIBE_EVENTS, { prefixes: ['Network.'] });
    const sub = await pick(powerTools, 'browser_events').handler({ action: 'subscribe', prefixes: ['Network.'] } as never, ctx);
    expect(textOf(sub)).toContain('Network.');

    const big = 'x'.repeat(5000);
    client.onMethod(Method.GET_EVENTS, {
      events: [{ method: 'Network.webSocketFrameReceived', tabId: 5, timestamp: 1, params: { response: { payloadData: big } } }],
    });
    const r = await pick(powerTools, 'browser_events').handler({ action: 'poll', maxLen: 100 } as never, ctx);
    expect(textOf(r)).toContain('…(5000 chars)');
    expect(textOf(r).length).toBeLessThan(1000);
  });

  it('browser_network start subscribes BEFORE enabling Network', async () => {
    client.onMethod(Method.SUBSCRIBE_EVENTS, { prefixes: ['Network.'] });
    client.onCdp('Network.enable', {});
    await pick(networkTools, 'browser_network').handler({ action: 'start', tabId: 5 } as never, ctx);
    const iSub = client.calls.findIndex((c) => c.method === Method.SUBSCRIBE_EVENTS);
    const iEnable = client.calls.findIndex((c) => innerMethod(c) === 'Network.enable');
    expect(iSub).toBeGreaterThanOrEqual(0);
    expect(iEnable).toBeGreaterThan(iSub);
  });

  it('browser_network body fetches a response body and truncates it', async () => {
    client.onCdp('Network.getResponseBody', { body: 'a'.repeat(300), base64Encoded: false });
    const r = await pick(networkTools, 'browser_network').handler({ action: 'body', tabId: 5, requestId: '1.2', maxLen: 50 } as never, ctx);
    const o = JSON.parse(textOf(r));
    expect(o.length).toBe(300);
    expect(o.body).toContain('…(300 chars)');
  });

  it('browser_sources search returns ±context snippets, not the whole file', async () => {
    const src = `${'_'.repeat(1000)}appKey:"34839810"${'_'.repeat(1000)}`;
    client.onCdp('Debugger.getScriptSource', { scriptSource: src });
    const r = await pick(sourcesTools, 'browser_sources').handler(
      { action: 'search', tabId: 5, scriptId: '11', query: 'appKey', context: 30, max: 5 } as never,
      ctx,
    );
    const o = JSON.parse(textOf(r));
    expect(o.totalLength).toBe(src.length);
    expect(o.hitCount).toBe(1);
    expect(o.hits[0].snippet).toContain('appKey:"34839810"');
    expect(o.hits[0].snippet.length).toBeLessThan(80);
  });

  it('browser_debug enable subscribes BEFORE Debugger.enable', async () => {
    client.onMethod(Method.SUBSCRIBE_EVENTS, { prefixes: ['Debugger.'] });
    client.onCdp('Debugger.enable', { debuggerId: 'x' });
    await pick(debuggerTools, 'browser_debug').handler({ action: 'enable', tabId: 5 } as never, ctx);
    const iSub = client.calls.findIndex((c) => c.method === Method.SUBSCRIBE_EVENTS);
    const iEnable = client.calls.findIndex((c) => innerMethod(c) === 'Debugger.enable');
    expect(iSub).toBeGreaterThanOrEqual(0);
    expect(iEnable).toBeGreaterThan(iSub);
  });

  it('browser_debug status summarises the latest paused call stack', async () => {
    client.onMethod(Method.GET_EVENTS, {
      events: [
        {
          method: 'Debugger.paused',
          tabId: 5,
          timestamp: 9,
          params: {
            reason: 'other',
            callFrames: [
              {
                callFrameId: 'cf1',
                functionName: 'sign',
                url: 'v.js',
                location: { scriptId: '11', lineNumber: 0, columnNumber: 42 },
                scopeChain: [{ type: 'local' }, { type: 'closure' }],
              },
            ],
          },
        },
      ],
    });
    const r = await pick(debuggerTools, 'browser_debug').handler({ action: 'status', tabId: 5 } as never, ctx);
    const o = JSON.parse(textOf(r));
    expect(o.reason).toBe('other');
    expect(o.stack[0]).toMatchObject({ fn: 'sign', callFrameId: 'cf1', scriptId: '11', col: 42, scopes: ['local', 'closure'] });
  });

  it('browser_debug eval_frame surfaces a thrown expression as an error', async () => {
    client.onCdp('Debugger.evaluateOnCallFrame', { result: {}, exceptionDetails: { exception: { description: 'ReferenceError: x' } } });
    const r = await pick(debuggerTools, 'browser_debug').handler(
      { action: 'eval_frame', tabId: 5, callFrameId: 'cf1', expression: 'x' } as never,
      ctx,
    );
    expect(textOf(r)).toContain('eval threw: ReferenceError: x');
  });
});
