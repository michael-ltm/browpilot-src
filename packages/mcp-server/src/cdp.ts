// Pure CDP command builders. No I/O, no Chrome, easy to unit test.

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

export type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/** One Input.dispatchMouseEvent command. */
function mouse(params: Record<string, unknown>): CdpCommand {
  return { method: 'Input.dispatchMouseEvent', params: { pointerType: 'mouse', ...params } };
}

/**
 * Ordered Input.dispatchMouseEvent commands for a click at (x,y), the same
 * sequence a real pointer produces (Chrome derives pointerover/enter, mouseover,
 * pointerdown, mousedown, focus, pointerup, mouseup, click and dblclick from it):
 * one mouseMoved (hover), then for each of `count` clicks a mousePressed +
 * mouseReleased with an incrementing clickCount (so double-click is count=2).
 */
export function clickEvents(
  x: number,
  y: number,
  button: MouseButton = 'left',
  count = 1,
  modifiers = 0,
): CdpCommand[] {
  const mask = BUTTON_MASK[button];
  const cmds: CdpCommand[] = [hoverEvent(x, y, modifiers)];
  for (let i = 1; i <= count; i++) {
    cmds.push(mouse({ type: 'mousePressed', x, y, button, buttons: mask, clickCount: i, modifiers }));
    cmds.push(mouse({ type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers }));
  }
  return cmds;
}

/** A hover: a single mouseMoved, from which Chrome derives over/enter/leave/out. */
export function hoverEvent(x: number, y: number, modifiers = 0): CdpCommand {
  return mouse({ type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0, modifiers });
}

/**
 * Left-button drag: hover the start, press, then move in `steps` interpolated
 * mouseMoved events with the button held, and release at the end. Drag libraries
 * (SortableJS, dnd-kit, vuedraggable, native HTML5 drag-and-drop) only start a
 * drag after the pointer travels past a threshold, so a single jump is not enough.
 */
export function dragEvents(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps = 10,
): CdpCommand[] {
  const n = Math.max(1, Math.round(steps));
  const cmds: CdpCommand[] = [
    hoverEvent(fromX, fromY),
    mouse({ type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 }),
  ];
  for (let i = 1; i <= n; i++) {
    const x = fromX + ((toX - fromX) * i) / n;
    const y = fromY + ((toY - fromY) * i) / n;
    cmds.push(mouse({ type: 'mouseMoved', x, y, button: 'left', buttons: 1, clickCount: 0 }));
  }
  cmds.push(mouse({ type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 }));
  return cmds;
}

/** Single mouseWheel dispatch with the pointer at (x,y); the element under it scrolls. */
export function wheelEvent(deltaX: number, deltaY: number, x = 0, y = 0): CdpCommand {
  return mouse({ type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0, clickCount: 0 });
}

// --- Keyboard ---------------------------------------------------------------

export interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Character the key inserts; absent for non-printing keys (Tab, arrows, ...). */
  text?: string;
  /** True when a US layout needs Shift held to produce `key`. */
  shift?: boolean;
  /** KeyboardEvent.location (1 = left modifier). */
  location?: number;
}

const MODIFIER_BIT: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/** Alt/Ctrl/Meta turn a printable key into a shortcut: it no longer inserts text. */
const SHORTCUT_MASK = 1 | 2 | 4;

const MODIFIER_KEY: Record<number, KeyDef> = {
  1: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, location: 1 },
  2: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, location: 1 },
  4: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, location: 1 },
  8: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, location: 1 },
};

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const SHIFT = MODIFIER_KEY[8]!;

/** US-layout punctuation: [code, keyCode, unshifted, shifted]. */
const PUNCTUATION: Array<[string, number, string, string]> = [
  ['Backquote', 192, '`', '~'],
  ['Minus', 189, '-', '_'],
  ['Equal', 187, '=', '+'],
  ['BracketLeft', 219, '[', '{'],
  ['BracketRight', 221, ']', '}'],
  ['Backslash', 220, '\\', '|'],
  ['Semicolon', 186, ';', ':'],
  ['Quote', 222, "'", '"'],
  ['Comma', 188, ',', '<'],
  ['Period', 190, '.', '>'],
  ['Slash', 191, '/', '?'],
];

const DIGIT_SHIFTED = ')!@#$%^&*(';

const NAMED_KEYS: Record<string, KeyDef> = {
  // Enter carries "\r" so it fires keypress and Chrome's default actions run
  // (implicit form submission, newline in a textarea), exactly like a real key.
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Shift: SHIFT,
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  Control: MODIFIER_KEY[2]!,
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  Alt: MODIFIER_KEY[1]!,
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  Meta: MODIFIER_KEY[4]!,
};
for (let f = 1; f <= 12; f++) {
  NAMED_KEYS[`F${f}`] = { key: `F${f}`, code: `F${f}`, windowsVirtualKeyCode: 111 + f };
}

const KEY_ALIASES: Record<string, string> = { esc: 'Escape', return: 'Enter', del: 'Delete' };

/**
 * Human key name or single character -> CDP key definition. Covers named keys
 * and every printable character of a US keyboard, shifted ones included.
 */
export const KEY_MAP: Record<string, KeyDef> = (() => {
  const map: Record<string, KeyDef> = { ...NAMED_KEYS, ' ': NAMED_KEYS.Space! };
  for (let c = 97; c <= 122; c++) {
    const lower = String.fromCharCode(c);
    const upper = lower.toUpperCase();
    const base = { code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
    map[lower] = { ...base, key: lower, text: lower };
    map[upper] = { ...base, key: upper, text: upper, shift: true };
  }
  for (let d = 0; d <= 9; d++) {
    const digit = String(d);
    const base = { code: `Digit${d}`, windowsVirtualKeyCode: digit.charCodeAt(0) };
    map[digit] = { ...base, key: digit, text: digit };
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const shifted = DIGIT_SHIFTED[d]!;
    map[shifted] = { ...base, key: shifted, text: shifted, shift: true };
  }
  for (const [code, windowsVirtualKeyCode, plain, shifted] of PUNCTUATION) {
    map[plain] = { key: plain, code, windowsVirtualKeyCode, text: plain };
    map[shifted] = { key: shifted, code, windowsVirtualKeyCode, text: shifted, shift: true };
  }
  return map;
})();

/** The Shift-produced variant of a key (a -> A, 1 -> !), if the layout has one. */
const SHIFTED_BY_CODE: Record<string, KeyDef> = Object.fromEntries(
  Object.values(KEY_MAP)
    .filter((d) => d.shift && d.text !== undefined)
    .map((d) => [d.code, d]),
);

/** The plain variant of a printable key (A -> a, ! -> 1). */
const UNSHIFTED_BY_CODE: Record<string, KeyDef> = Object.fromEntries(
  Object.values(KEY_MAP)
    .filter((d) => !d.shift && d.text !== undefined && d.key.length === 1)
    .map((d) => [d.code, d]),
);

const NAMED_BY_LOWER: Record<string, KeyDef> = Object.fromEntries(
  Object.entries(NAMED_KEYS).map(([name, def]) => [name.toLowerCase(), def]),
);

function resolveKey(name: string): KeyDef {
  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  if (KEY_MAP[name]) return KEY_MAP[name]!;
  const lower = name.toLowerCase();
  if (NAMED_BY_LOWER[lower]) return NAMED_BY_LOWER[lower]!;
  if (KEY_ALIASES[lower]) return NAMED_KEYS[KEY_ALIASES[lower]!]!;
  /* eslint-enable @typescript-eslint/no-non-null-assertion */
  throw new Error(`keyEvents: unknown key "${name}"`);
}

/**
 * Editing commands for Ctrl/Cmd shortcuts. CDP key events bypass the OS
 * shortcut layer on macOS, so without these Cmd+A/C/X/V/Z do nothing there;
 * with them the shortcut works the same on every platform.
 */
function editCommand(code: string, mask: number): string | undefined {
  if ((mask & (2 | 4)) === 0 || (mask & 1) !== 0) return undefined;
  const shift = (mask & 8) !== 0;
  switch (code) {
    case 'KeyA': return shift ? undefined : 'selectAll';
    case 'KeyC': return shift ? undefined : 'copy';
    case 'KeyX': return shift ? undefined : 'cut';
    case 'KeyV': return shift ? undefined : 'paste';
    case 'KeyZ': return shift ? 'redo' : 'undo';
    case 'KeyY': return shift ? undefined : 'redo';
    default: return undefined;
  }
}

/**
 * keyDown for a key under `modifiers`. A key that inserts text (and is not a
 * shortcut) is a full `keyDown` carrying the text, so Chrome fires keydown,
 * keypress, beforeinput and input and runs the default action; anything else is
 * a `rawKeyDown`, which fires keydown alone, like a real non-printing key.
 */
function keyDownCmd(def: KeyDef, modifiers: number, commands?: string[]): CdpCommand {
  const text = def.text !== undefined && (modifiers & SHORTCUT_MASK) === 0 ? def.text : undefined;
  return {
    method: 'Input.dispatchKeyEvent',
    params: {
      type: text === undefined ? 'rawKeyDown' : 'keyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
      ...(def.location ? { location: def.location } : {}),
      ...(commands?.length ? { commands } : {}),
    },
  };
}

function keyUpCmd(def: KeyDef, modifiers: number): CdpCommand {
  return {
    method: 'Input.dispatchKeyEvent',
    params: {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
      ...(def.location ? { location: def.location } : {}),
    },
  };
}

/** Parse modifier names ("Control", "Shift", ...) into their bits, in order. */
export function modifierBits(names: string[]): number[] {
  return names.map((m) => {
    const bit = MODIFIER_BIT[m.toLowerCase()];
    if (bit === undefined) throw new Error(`keyEvents: unknown modifier "${m}"`);
    return bit;
  });
}

/** Press modifiers down (accumulating the mask), run `inner(mask)`, release in reverse. */
export function withModifiers(bits: number[], inner: (mask: number) => CdpCommand[]): CdpCommand[] {
  const cmds: CdpCommand[] = [];
  let accum = 0;
  for (const bit of bits) {
    accum |= bit;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    cmds.push(keyDownCmd(MODIFIER_KEY[bit]!, accum));
  }
  cmds.push(...inner(accum));
  for (let i = bits.length - 1; i >= 0; i--) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const bit = bits[i]!;
    accum &= ~bit;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    cmds.push(keyUpCmd(MODIFIER_KEY[bit]!, accum));
  }
  return cmds;
}

/**
 * Builds dispatchKeyEvent commands for a single key or a chord like "Cmd+A".
 * Order: each modifier down (accumulating bitmask), the inner key down+up with
 * the full modifier bitmask, then each modifier up in reverse.
 */
export function keyEvents(keys: string): CdpCommand[] {
  // "+" alone (or last, as in "Shift++") is the plus key, not a separator.
  const parts =
    keys === '+' ? ['+'] : keys.endsWith('++') ? [...keys.slice(0, -2).split('+'), '+'] : keys.split('+');
  const names = parts.map((p) => (p === ' ' ? p : p.trim())).filter(Boolean);
  if (names.length === 0) throw new Error('keyEvents: empty key sequence');

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const mainName = names[names.length - 1]!;
  let bits = modifierBits(names.slice(0, -1));
  const mask = bits.reduce((m, b) => m | b, 0);
  const named = resolveKey(mainName);
  let main = named;
  if ((mask & 8) !== 0) {
    // Shift+a types "A", as it would on a real keyboard.
    main = SHIFTED_BY_CODE[named.code] ?? named;
  } else if (named.shift && bits.length > 0) {
    // "Control+A" names the A key, not a capital A.
    main = UNSHIFTED_BY_CODE[named.code] ?? named;
  } else if (named.shift) {
    // A lone "A" or "!" is typed with Shift held.
    bits = [8];
  }
  const command = editCommand(main.code, mask);

  return withModifiers(bits, (m) => [
    keyDownCmd(main, m, command ? [command] : undefined),
    keyUpCmd(main, m),
  ]);
}

/**
 * Commit `text` through an input-method composition, the way a Chinese or
 * Japanese IME (or a dead-key/compose sequence) delivers it: compositionstart,
 * compositionupdate and beforeinput/input with isComposing, then compositionend.
 */
export function compositionEvents(text: string): CdpCommand[] {
  return [
    {
      method: 'Input.imeSetComposition',
      params: { text, selectionStart: text.length, selectionEnd: text.length },
    },
    insertTextCmd(text),
  ];
}

/**
 * Commands that type `text` as a person would. Each character on a US keyboard
 * is a real keystroke (keydown, keypress, beforeinput, input, keyup), holding
 * Shift for shifted characters; "\n" presses Enter. Runs of anything else (CJK,
 * emoji, accented letters) are committed through an IME composition.
 */
export function typeEvents(text: string): CdpCommand[] {
  const cmds: CdpCommand[] = [];
  let composed = '';
  const flush = (): void => {
    if (composed) cmds.push(...compositionEvents(composed));
    composed = '';
  };
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const def = ch === '\n' ? NAMED_KEYS.Enter : KEY_MAP[ch];
    if (!def || def.text === undefined) {
      composed += ch;
      continue;
    }
    flush();
    if (def.shift) {
      cmds.push(keyDownCmd(SHIFT, 8), keyDownCmd(def, 8), keyUpCmd(def, 8), keyUpCmd(SHIFT, 0));
    } else {
      cmds.push(keyDownCmd(def, 0), keyUpCmd(def, 0));
    }
  }
  flush();
  return cmds;
}

// --- Text & screenshot ------------------------------------------------------

/** Input.insertText: inserts text without key events, like a paste or an emoji picker. */
export function insertTextCmd(text: string): CdpCommand {
  return { method: 'Input.insertText', params: { text } };
}

/** Params object for Page.captureScreenshot. fullPage => captureBeyondViewport. */
export function screenshotParams(fullPage: boolean): Record<string, unknown> {
  return { format: 'png', captureBeyondViewport: fullPage };
}
