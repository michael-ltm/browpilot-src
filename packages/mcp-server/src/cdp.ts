// Pure CDP command builders. No I/O, no Chrome, easy to unit test.

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

export type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/**
 * Ordered Input.dispatchMouseEvent commands for a click at (x,y):
 * one mouseMoved, then for each of `count` clicks a mousePressed + mouseReleased
 * with an incrementing clickCount (so double-click is count=2).
 */
export function clickEvents(
  x: number,
  y: number,
  button: MouseButton = 'left',
  count = 1,
): CdpCommand[] {
  const mask = BUTTON_MASK[button];
  const cmds: CdpCommand[] = [
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 },
    },
  ];
  for (let i = 1; i <= count; i++) {
    cmds.push({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x, y, button, buttons: mask, clickCount: i },
    });
    cmds.push({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i },
    });
  }
  return cmds;
}

/** Single mouseWheel dispatch. x/y default to 0 (scroll at origin / current). */
export function wheelEvent(deltaX: number, deltaY: number, x = 0, y = 0): CdpCommand {
  return {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0, clickCount: 0 },
  };
}

/** Center of a DOM.getBoxModel quad: [x1,y1,x2,y2,x3,y3,x4,y4]. */
export function boxCenter(quad: number[]): { x: number; y: number } {
  if (!Array.isArray(quad) || quad.length !== 8) {
    throw new Error(`boxCenter: expected an 8-number quad, got length ${quad.length}`);
  }
  // Length is exactly 8 (guarded above); non-null assertions are safe here.
  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = (xs[0]! + xs[1]! + xs[2]! + xs[3]!) / 4;
  const y = (ys[0]! + ys[1]! + ys[2]! + ys[3]!) / 4;
  /* eslint-enable @typescript-eslint/no-non-null-assertion */
  return { x, y };
}
