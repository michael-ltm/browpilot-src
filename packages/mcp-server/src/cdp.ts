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

// --- Keyboard ---------------------------------------------------------------

export interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
}

const MODIFIER_BIT: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const MODIFIER_KEY: Record<number, KeyDef> = {
  1: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  2: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  4: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  8: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
};

function letterDef(ch: string): KeyDef {
  const upper = ch.toUpperCase();
  return { key: ch, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
}

function digitDef(d: string): KeyDef {
  return { key: d, code: `Digit${d}`, windowsVirtualKeyCode: d.charCodeAt(0) };
}

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

/** Human key name -> CDP key definition. Single letters/digits are generated. */
export const KEY_MAP: Record<string, KeyDef> = (() => {
  const map: Record<string, KeyDef> = { ...NAMED_KEYS };
  for (let c = 97; c <= 122; c++) {
    const lower = String.fromCharCode(c);
    map[lower] = letterDef(lower);
    map[lower.toUpperCase()] = letterDef(lower);
  }
  for (let d = 0; d <= 9; d++) map[String(d)] = digitDef(String(d));
  return map;
})();

function resolveKey(name: string): KeyDef {
  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  if (KEY_MAP[name]) return KEY_MAP[name]!;
  if (name.length === 1 && KEY_MAP[name.toLowerCase()]) return KEY_MAP[name.toLowerCase()]!;
  /* eslint-enable @typescript-eslint/no-non-null-assertion */
  throw new Error(`keyEvents: unknown key "${name}"`);
}

/**
 * Builds dispatchKeyEvent commands for a single key or a chord like "Cmd+A".
 * Order: each modifier down (accumulating bitmask), the inner key down+up with
 * the full modifier bitmask, then each modifier up in reverse.
 */
export function keyEvents(keys: string): CdpCommand[] {
  const parts = keys.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('keyEvents: empty key sequence');

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const mainName = parts[parts.length - 1]!;
  const modifierNames = parts.slice(0, -1);

  let mask = 0;
  const modifierBits: number[] = [];
  for (const m of modifierNames) {
    const bit = MODIFIER_BIT[m.toLowerCase()];
    if (bit === undefined) throw new Error(`keyEvents: unknown modifier "${m}"`);
    mask |= bit;
    modifierBits.push(bit);
  }

  const main = resolveKey(mainName);
  const cmds: CdpCommand[] = [];

  // Modifier key-downs, accumulating the bitmask as each goes down.
  let accum = 0;
  for (const bit of modifierBits) {
    accum |= bit;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const def = MODIFIER_KEY[bit]!;
    cmds.push({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, modifiers: accum },
    });
  }

  // Inner key with the full modifier mask applied.
  cmds.push({
    method: 'Input.dispatchKeyEvent',
    params: { type: 'rawKeyDown', key: main.key, code: main.code, windowsVirtualKeyCode: main.windowsVirtualKeyCode, modifiers: mask },
  });
  cmds.push({
    method: 'Input.dispatchKeyEvent',
    params: { type: 'keyUp', key: main.key, code: main.code, windowsVirtualKeyCode: main.windowsVirtualKeyCode, modifiers: mask },
  });

  // Modifier key-ups in reverse, peeling the bitmask back down.
  for (let i = modifierBits.length - 1; i >= 0; i--) {
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    const bit = modifierBits[i]!;
    accum &= ~bit;
    const def = MODIFIER_KEY[bit]!;
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
    cmds.push({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, modifiers: accum },
    });
  }

  return cmds;
}
