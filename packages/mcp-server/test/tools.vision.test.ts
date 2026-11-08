import { describe, it, expect, beforeEach } from 'vitest';
import { visionTools } from '../src/tools/vision.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@browpilot/shared';

function toolByName(name: string) {
  const t = visionTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('vision tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_screenshot attaches and sends Page.captureScreenshot, returning an image content block', async () => {
    client.onCdp('Page.captureScreenshot', { data: 'aGVsbG8=' });
    const res = await toolByName('browser_screenshot').handler({ fullPage: false, tabId: 3 }, ctx);
    // attach first
    expect(client.calls[0]).toMatchObject({ method: Method.ATTACH, params: { tabId: 3 } });
    // then the screenshot CDP
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const cdp = client.cdpCalls()[0]!;
    expect(cdp.method).toBe('Page.captureScreenshot');
    expect(cdp.params).toEqual({ format: 'png', captureBeyondViewport: false });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(res.content[0]!).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });

  it('browser_click sends move+press+release via EXECUTE_CDP', async () => {
    await toolByName('browser_click').handler({ x: 10, y: 20, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[1]!.params).toMatchObject({ x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 });
  });

  it('browser_click honors button and count', async () => {
    await toolByName('browser_click').handler({ x: 1, y: 1, button: 'right', count: 2, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp).toHaveLength(5); // move + 2*(press+release)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[1]!.params).toMatchObject({ button: 'right', buttons: 2, clickCount: 1 });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[3]!.params).toMatchObject({ clickCount: 2 });
  });

  it('browser_move sends a single mouseMoved', async () => {
    await toolByName('browser_move').handler({ x: 7, y: 8, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[0]!.params).toMatchObject({ type: 'mouseMoved', x: 7, y: 8 });
  });

  it('browser_type types each character as real key events', async () => {
    await toolByName('browser_type').handler({ text: 'hi', tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.map((c) => `${c.params?.type}:${c.params?.key}`)).toEqual(['keyDown:h', 'keyUp:h', 'keyDown:i', 'keyUp:i']);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[0]!.params).toMatchObject({ text: 'h' });
  });

  it('browser_type sends Chinese through an IME composition', async () => {
    await toolByName('browser_type').handler({ text: '中文', tabId: 1 }, ctx);
    expect(client.cdpCalls().map((c) => c.method)).toEqual(['Input.imeSetComposition', 'Input.insertText']);
  });

  it('browser_press_key expands a chord into key events', async () => {
    await toolByName('browser_press_key').handler({ keys: 'Cmd+A', tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[0]!.params).toMatchObject({ key: 'Meta', modifiers: 4 });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[1]!.params).toMatchObject({ code: 'KeyA', modifiers: 4 });
  });

  it('browser_scroll sends a mouseWheel with deltas', async () => {
    await toolByName('browser_scroll').handler({ deltaX: 0, deltaY: 120, x: 5, y: 6, tabId: 1 }, ctx);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(client.cdpCalls()[0]!).toMatchObject({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', deltaX: 0, deltaY: 120, x: 5, y: 6 },
    });
  });

  it('browser_scroll points the wheel at the viewport center by default', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: [400, 300] } });
    await toolByName('browser_scroll').handler({ deltaX: 0, deltaY: 120, tabId: 1 }, ctx);
    const wheel = client.cdpCalls().find((c) => c.params?.type === 'mouseWheel');
    expect(wheel?.params).toMatchObject({ x: 400, y: 300, deltaY: 120 });
  });

  it('browser_drag hovers, presses, moves in steps with the button held, and releases', async () => {
    await toolByName('browser_drag').handler({ fromX: 0, fromY: 0, toX: 30, toY: 60, steps: 3, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.map((c) => c.params?.type)).toEqual([
      'mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased',
    ]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[1]!.params).toMatchObject({ x: 0, y: 0, button: 'left', buttons: 1 });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[2]!.params).toMatchObject({ x: 10, y: 20, buttons: 1 });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(cdp[5]!.params).toMatchObject({ x: 30, y: 60, button: 'left', buttons: 0 });
  });
});
