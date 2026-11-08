import { describe, it, expect, beforeEach } from 'vitest';
import { domTools } from '../src/tools/dom.js';
import { compactAxTree } from '../src/snapshot.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@browpilot/shared';

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

  /** Fake page: ref nodes resolve to handles; page functions answer by what they are. */
  function fakePage(opts: {
    info?: Record<string, unknown>;
    focus?: Array<Record<string, unknown>>;
    hit?: number;
    blocker?: string | null;
  } = {}) {
    const info = { kind: 'text', tag: 'input', type: 'text', multiline: false, readOnly: false, disabled: false, checked: false, ...opts.info };
    const focus = [...(opts.focus ?? [{ focused: true, editable: true, readOnly: false, value: '' }])];
    client.onCdp('DOM.resolveNode', (p: Record<string, unknown>) => ({ object: { objectId: `obj-${p.backendNodeId}` } }));
    client.onCdp('DOM.getContentQuads', { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] });
    client.onCdp('DOM.getNodeForLocation', { backendNodeId: opts.hit ?? 100 });
    client.onCdp('Runtime.callFunctionOn', (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      if (fn.includes('scrollIntoView')) return { result: { objectId: 'target' } };
      if (fn.includes("kind = 'other'")) return { result: { value: info } };
      if (fn.includes('activeElement')) return { result: { value: focus.length > 1 ? focus.shift() : focus[0] } };
      if (fn.includes('owners')) return { result: { value: opts.blocker ?? null } };
      if (fn.includes('sel.options')) return { result: { value: 'Shanghai (value "sh")' } };
      return { result: {} };
    });
  }

  it('browser_click_ref scrolls into view, hit-tests, and clicks the content-quad center', async () => {
    ctx.refs.set('ref1', 100);
    fakePage();
    const res = await tool('browser_click_ref').handler({ ref: 'ref1', tabId: 5 }, ctx);
    expect(res.isError).toBeFalsy();
    const cdp = client.cdpCalls();
    expect(cdp.find((c) => c.method === 'DOM.resolveNode')?.params).toMatchObject({ backendNodeId: 100 });
    expect(cdp.some((c) => c.method === 'Runtime.callFunctionOn' && /scrollIntoView/.test(String(c.params?.functionDeclaration)))).toBe(true);
    expect(cdp.find((c) => c.method === 'DOM.getNodeForLocation')?.params).toMatchObject({ x: 60, y: 40 });
    const mouse = cdp.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(mouse[1]?.params).toMatchObject({ x: 60, y: 40, button: 'left' });
  });

  it('browser_click_ref refuses to click through an overlay unless forced', async () => {
    ctx.refs.set('ref1', 100);
    fakePage({ hit: 999, blocker: '<div.modal-mask>' });
    const res = await tool('browser_click_ref').handler({ ref: 'ref1', tabId: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/covered by <div\.modal-mask>/);
    expect(client.cdpCalls().some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);

    const forced = await tool('browser_click_ref').handler({ ref: 'ref1', force: true, tabId: 5 }, ctx);
    expect(forced.isError).toBeFalsy();
    expect(client.cdpCalls().some((c) => c.params?.type === 'mousePressed')).toBe(true);
  }, 10_000);

  it('browser_click_ref holds modifiers around the click', async () => {
    ctx.refs.set('ref1', 100);
    fakePage();
    await tool('browser_click_ref').handler({ ref: 'ref1', modifiers: ['Control'], tabId: 5 }, ctx);
    const input = client.cdpCalls().filter((c) => c.method.startsWith('Input.'));
    expect(input.map((c) => `${c.params?.type}`)).toEqual(['rawKeyDown', 'mouseMoved', 'mousePressed', 'mouseReleased', 'keyUp']);
    expect(input[2]?.params).toMatchObject({ modifiers: 2 });
  });

  it('browser_click_ref errors with a stale-ref message when ref is unknown', async () => {
    const res = await tool('browser_click_ref').handler({ ref: 'refZ', tabId: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect((res.content[0] as { text: string }).text).toMatch(/stale|unknown ref/i);
  });

  it('browser_fill clicks in, selects all + Backspace when non-empty, then types key by key', async () => {
    ctx.refs.set('ref2', 200);
    fakePage({
      hit: 200,
      focus: [
        { focused: true, editable: true, readOnly: false, value: 'old' },
        { focused: true, editable: true, readOnly: false, value: 'a@b' },
      ],
    });
    const res = await tool('browser_fill').handler({ ref: 'ref2', value: 'a@b', tabId: 5 }, ctx);
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe('filled ref2');
    const input = client.cdpCalls().filter((c) => c.method.startsWith('Input.'));
    expect(input.slice(0, 3).map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    const keys = input.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => `${c.params?.type}:${c.params?.key}`);
    expect(keys).toEqual([
      'rawKeyDown:Control', 'rawKeyDown:a', 'keyUp:a', 'keyUp:Control',
      'rawKeyDown:Backspace', 'keyUp:Backspace',
      'keyDown:a', 'keyUp:a', 'rawKeyDown:Shift', 'keyDown:@', 'keyUp:@', 'keyUp:Shift', 'keyDown:b', 'keyUp:b',
    ]);
    expect(input.find((c) => c.params?.key === 'a' && c.params?.modifiers === 2)?.params?.commands).toEqual(['selectAll']);
  });

  it('browser_fill skips clearing an empty field and reports a reformatted value', async () => {
    ctx.refs.set('ref2', 200);
    fakePage({
      hit: 200,
      focus: [
        { focused: true, editable: true, readOnly: false, value: '' },
        { focused: true, editable: true, readOnly: false, value: '123-4' },
      ],
    });
    const res = await tool('browser_fill').handler({ ref: 'ref2', value: '1234', tabId: 5 }, ctx);
    expect(client.cdpCalls().some((c) => c.params?.key === 'Backspace')).toBe(false);
    expect((res.content[0] as { text: string }).text).toMatch(/now shows "123-4"/);
  });

  it('browser_fill refuses read-only inputs without typing', async () => {
    ctx.refs.set('ref2', 200);
    fakePage({ hit: 200, focus: [{ focused: true, editable: true, readOnly: true, value: '' }] });
    const res = await tool('browser_fill').handler({ ref: 'ref2', value: 'x', tabId: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect(client.cdpCalls().some((c) => c.method === 'Input.dispatchKeyEvent')).toBe(false);
  });

  it('browser_fill picks an option of a native select without key events', async () => {
    ctx.refs.set('ref3', 300);
    fakePage({ info: { kind: 'select', tag: 'select' } });
    const res = await tool('browser_fill').handler({ ref: 'ref3', value: 'Shanghai', tabId: 5 }, ctx);
    expect((res.content[0] as { text: string }).text).toBe('selected Shanghai (value "sh") in ref3');
    const call = client.cdpCalls().find((c) => /sel\.options/.test(String(c.params?.functionDeclaration)));
    expect(call?.params?.arguments).toEqual([{ value: 'Shanghai' }]);
  });

  it('browser_fill clicks a checkbox only when its state differs', async () => {
    ctx.refs.set('ref4', 400);
    fakePage({ info: { kind: 'toggle', tag: 'input', type: 'checkbox', checked: true } });
    const res = await tool('browser_fill').handler({ ref: 'ref4', value: 'true', tabId: 5 }, ctx);
    expect((res.content[0] as { text: string }).text).toBe('ref4 is checked');
    expect(client.cdpCalls().some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
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
