import { describe, it, expect, beforeEach } from 'vitest';
import { navigationTools, __setSleep } from '../src/tools/navigation.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function tool(name: string) {
  const t = navigationTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('navigation tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
    __setSleep(() => Promise.resolve());
  });

  it('browser_navigate attaches then calls Page.navigate with the url', async () => {
    await tool('browser_navigate').handler({ url: 'https://example.com', tabId: 2 }, ctx);
    expect(client.calls[0]).toMatchObject({ method: Method.ATTACH, params: { tabId: 2 } });
    expect(client.cdpCalls()[0]).toMatchObject({
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
  });

  it('browser_back issues a negative-entry Page.navigateToHistoryEntry via history delta', async () => {
    client.onCdp('Page.getNavigationHistory', { currentIndex: 2, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
    await tool('browser_back').handler({ tabId: 2 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.some((c) => c.method === 'Page.getNavigationHistory')).toBe(true);
    expect(cdp.some((c) => c.method === 'Page.navigateToHistoryEntry' && c.params?.entryId === 11)).toBe(true);
  });

  it('browser_forward navigates to the next history entry', async () => {
    client.onCdp('Page.getNavigationHistory', { currentIndex: 0, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
    await tool('browser_forward').handler({ tabId: 2 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.some((c) => c.method === 'Page.navigateToHistoryEntry' && c.params?.entryId === 11)).toBe(true);
  });

  it('browser_reload calls Page.reload', async () => {
    await tool('browser_reload').handler({ tabId: 2 }, ctx);
    expect(client.cdpCalls()[0]!.method).toBe('Page.reload');
  });

  it('browser_wait with ms resolves without CDP calls', async () => {
    const res = await tool('browser_wait').handler({ ms: 500, tabId: 2 }, ctx);
    expect(client.cdpCalls()).toHaveLength(0);
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('browser_wait with selector polls Runtime.evaluate until the element exists', async () => {
    let calls = 0;
    // First poll: missing; second poll: present.
    client.request = async (method, params) => {
      (client.calls as unknown[]).push({ method, params });
      const inner = (params as { method?: string }).method;
      if (inner === 'Runtime.evaluate') {
        calls++;
        return { result: { value: calls >= 2 } } as never;
      }
      return undefined as never;
    };
    await tool('browser_wait').handler({ selector: '#ready', tabId: 2 }, ctx);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
