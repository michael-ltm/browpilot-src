import { describe, it, expect, beforeEach } from 'vitest';
import { tabsTools } from '../src/tools/tabs.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function tool(name: string) {
  const t = tabsTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('tabs tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_get_tabs calls Method.GET_TABS and lists tabs', async () => {
    client.onMethod(Method.GET_TABS, { tabs: [{ id: 1, url: 'https://a', title: 'A', active: true }] });
    const res = await tool('browser_get_tabs').handler({}, ctx);
    expect(client.last()).toMatchObject({ method: Method.GET_TABS });
    expect((res.content[0] as { text: string }).text).toContain('https://a');
  });

  it('browser_new_tab calls Method.NEW_TAB with the url', async () => {
    client.onMethod(Method.NEW_TAB, { id: 9, url: 'https://x' });
    await tool('browser_new_tab').handler({ url: 'https://x' }, ctx);
    expect(client.last()).toMatchObject({ method: Method.NEW_TAB, params: { url: 'https://x' } });
  });

  it('browser_switch_tab calls Method.SWITCH_TAB with tabId', async () => {
    await tool('browser_switch_tab').handler({ tabId: 4 }, ctx);
    expect(client.last()).toMatchObject({ method: Method.SWITCH_TAB, params: { tabId: 4 } });
  });

  it('browser_close_tab calls Method.CLOSE_TAB with tabId', async () => {
    await tool('browser_close_tab').handler({ tabId: 4 }, ctx);
    expect(client.last()).toMatchObject({ method: Method.CLOSE_TAB, params: { tabId: 4 } });
  });
});
