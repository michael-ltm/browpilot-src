import { describe, it, expect } from 'vitest';
import { clickEvents, wheelEvent, boxCenter, type CdpCommand } from '../src/cdp.js';

describe('clickEvents', () => {
  it('produces ordered moved -> pressed -> released for a single left click', () => {
    const cmds = clickEvents(10, 20);
    expect(cmds).toEqual<CdpCommand[]>([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0, clickCount: 0 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1 } },
    ]);
  });

  it('emits pressed/released pairs for each click in a double click with incrementing clickCount', () => {
    const cmds = clickEvents(5, 6, 'left', 2);
    // 1 move + 2 * (press + release) = 5 commands
    expect(cmds).toHaveLength(5);
    expect(cmds[0]!.params.type).toBe('mouseMoved');
    expect(cmds[1]!.params).toMatchObject({ type: 'mousePressed', clickCount: 1, buttons: 1 });
    expect(cmds[2]!.params).toMatchObject({ type: 'mouseReleased', clickCount: 1, buttons: 0 });
    expect(cmds[3]!.params).toMatchObject({ type: 'mousePressed', clickCount: 2, buttons: 1 });
    expect(cmds[4]!.params).toMatchObject({ type: 'mouseReleased', clickCount: 2, buttons: 0 });
  });

  it('maps right button to buttons bitmask 2', () => {
    const cmds = clickEvents(1, 2, 'right', 1);
    expect(cmds[0]!.params).toMatchObject({ type: 'mouseMoved', button: 'none' });
    expect(cmds[1]!.params).toMatchObject({ button: 'right', buttons: 2, type: 'mousePressed' });
    expect(cmds[2]!.params).toMatchObject({ button: 'right', buttons: 0, type: 'mouseReleased' });
  });

  it('maps middle button to buttons bitmask 4', () => {
    const cmds = clickEvents(0, 0, 'middle', 1);
    expect(cmds[0]!.params).toMatchObject({ type: 'mouseMoved', button: 'none' });
    expect(cmds[1]!.params).toMatchObject({ button: 'middle', buttons: 4 });
  });

  it('count=0 yields only the hover mouseMoved with button none', () => {
    const cmds = clickEvents(7, 8, 'left', 0);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.params).toMatchObject({ type: 'mouseMoved', button: 'none', buttons: 0, clickCount: 0 });
  });
});

describe('wheelEvent', () => {
  it('produces a single mouseWheel dispatch with deltas', () => {
    expect(wheelEvent(0, 120, 50, 60)).toEqual<CdpCommand>({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 50, y: 60, deltaX: 0, deltaY: 120, button: 'none', buttons: 0, clickCount: 0 },
    });
  });

  it('defaults coordinates to 0,0 when omitted', () => {
    expect(wheelEvent(30, -40).params).toMatchObject({ x: 0, y: 0, deltaX: 30, deltaY: -40 });
  });
});

describe('boxCenter', () => {
  it('returns the centroid of a getBoxModel content quad [x1,y1,x2,y2,x3,y3,x4,y4]', () => {
    // 100x40 box at (10,20): quad = TL,TR,BR,BL
    const quad = [10, 20, 110, 20, 110, 60, 10, 60];
    expect(boxCenter(quad)).toEqual({ x: 60, y: 40 });
  });

  it('throws on a malformed quad', () => {
    expect(() => boxCenter([1, 2, 3])).toThrow(/quad/i);
  });
});
