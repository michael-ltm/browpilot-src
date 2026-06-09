import { describe, it, expect, beforeEach } from 'vitest';
import { domTools } from '../src/tools/dom.js';
import { compactAxTree } from '../src/snapshot.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function tool(name: string) {
  const t = domTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const SAMPLE_AX = {
  nodes: [
    {
      nodeId: '1',
      backendDOMNodeId: 100,
      role: { value: 'button' },
      name: { value: 'Submit' },
      ignored: false,
    },
    {
      nodeId: '2',
      backendDOMNodeId: 200,
      role: { value: 'textbox' },
      name: { value: 'Email' },
      ignored: false,
    },
    {
      nodeId: '3',
      backendDOMNodeId: 300,
      role: { value: 'generic' },
      name: { value: '' },
      ignored: true, // ignored nodes are dropped
    },
  ],
};

describe('compactAxTree', () => {
  it('assigns sequential refs to non-ignored named nodes and maps ref -> backendDOMNodeId', () => {
    const { refs, outline } = compactAxTree(SAMPLE_AX);
    expect([...refs.entries()]).toEqual([
      ['ref1', 100],
      ['ref2', 200],
    ]);
    expect(outline).toContain('[ref1] button "Submit"');
    expect(outline).toContain('[ref2] textbox "Email"');
    expect(outline).not.toContain('generic');
  });
});

describe('dom tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_snapshot attaches, calls Accessibility.getFullAXTree, and fills ctx.refs', async () => {
    client.onCdp('Accessibility.getFullAXTree', SAMPLE_AX);
    const res = await tool('browser_snapshot').handler({ tabId: 5 }, ctx);
    expect(client.calls[0]).toMatchObject({ method: Method.ATTACH, params: { tabId: 5 } });
    expect(client.cdpCalls()[0]!.method).toBe('Accessibility.getFullAXTree');
    expect(ctx.refs.get('ref1')).toBe(100);
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('browser_click_ref resolves the ref via DOM.getBoxModel and clicks the box center', async () => {
    ctx.refs.set('ref1', 100);
    client.onCdp('DOM.getBoxModel', { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } });
    await tool('browser_click_ref').handler({ ref: 'ref1', tabId: 5 }, ctx);
    const cdp = client.cdpCalls();
    // getBoxModel is called with the backendNodeId
    const box = cdp.find((c) => c.method === 'DOM.getBoxModel');
    expect(box?.params).toMatchObject({ backendNodeId: 100 });
    // then a click sequence at the center (60,40)
    const press = cdp.find((c) => c.params?.type === 'mousePressed');
    expect(press?.params).toMatchObject({ x: 60, y: 40, button: 'left' });
  });

  it('browser_click_ref errors with a stale-ref message when ref is unknown', async () => {
    const res = await tool('browser_click_ref').handler({ ref: 'refZ', tabId: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect((res.content[0] as { text: string }).text).toMatch(/stale|unknown ref/i);
  });

  it('browser_fill resolves the ref, focuses it, and inserts text', async () => {
    ctx.refs.set('ref2', 200);
    client.onCdp('DOM.getBoxModel', { model: { content: [0, 0, 50, 0, 50, 20, 0, 20] } });
    await tool('browser_fill').handler({ ref: 'ref2', value: 'a@b.com', tabId: 5 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.some((c) => c.method === 'DOM.focus' && c.params?.backendNodeId === 200)).toBe(true);
    // clears existing content first (select-all + trusted Backspace) so fill REPLACES, not appends
    expect(cdp.some((c) => c.method === 'Runtime.evaluate' && /el\.select|selectNodeContents/.test(String(c.params?.expression)))).toBe(true);
    expect(cdp.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params?.key === 'Backspace')).toBe(true);
    expect(cdp.some((c) => c.method === 'Input.insertText' && c.params?.text === 'a@b.com')).toBe(true);
  });

  it('browser_query runs Runtime.evaluate with a querySelector expression', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: '["#main"]' } });
    await tool('browser_query').handler({ selector: '#main', tabId: 5 }, ctx);
    const ev = client.cdpCalls()[0]!;
    expect(ev.method).toBe('Runtime.evaluate');
    expect(String(ev.params?.expression)).toContain('#main');
    expect(ev.params).toMatchObject({ returnByValue: true });
  });

  it('browser_get_text evaluates innerText for a selector (or body when omitted)', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: 'hello' } });
    await tool('browser_get_text').handler({ tabId: 5 }, ctx);
    const ev = client.cdpCalls()[0]!;
    expect(String(ev.params?.expression)).toContain('innerText');
  });

  it('browser_eval runs the raw expression and warns in its description', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: 42 } });
    const t = tool('browser_eval');
    expect(t.description.toLowerCase()).toContain('arbitrary');
    const res = await t.handler({ expression: '40 + 2', tabId: 5 }, ctx);
    const ev = client.cdpCalls()[0]!;
    // awaitPromise is required so async expressions resolve instead of returning a bare Promise ({}).
    expect(ev.params).toMatchObject({ expression: '40 + 2', returnByValue: true, awaitPromise: true });
    expect((res.content[0] as { text: string }).text).toBe('42');
  });

  it('browser_eval surfaces a thrown/rejected expression as an error instead of null', async () => {
    client.onCdp('Runtime.evaluate', {
      result: { value: undefined },
      exceptionDetails: { exception: { description: 'ReferenceError: nope is not defined' } },
    });
    const res = await tool('browser_eval').handler({ expression: 'nope', tabId: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/ReferenceError: nope/);
  });
});
