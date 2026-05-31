import { describe, it, expect } from 'vitest';
import { keyEvents, KEY_MAP } from '../src/cdp.js';

describe('KEY_MAP', () => {
  it('maps Enter to the correct code/keyCode', () => {
    expect(KEY_MAP['Enter']).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  });
  it('maps a letter case-insensitively', () => {
    expect(KEY_MAP['a']).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  });
});

describe('keyEvents', () => {
  it('emits keyDown then keyUp for a plain key', () => {
    const cmds = keyEvents('Enter');
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    });
    expect(cmds[1]).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    });
  });

  it('wraps a chord with modifier down/up and applies the modifier bitmask to the inner key', () => {
    const cmds = keyEvents('Cmd+A'); // Meta = 4
    // Meta down, A down, A up, Meta up
    expect(cmds).toHaveLength(4);
    expect(cmds[0].params).toMatchObject({ type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
    expect(cmds[1].params).toMatchObject({ type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4 });
    expect(cmds[2].params).toMatchObject({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    expect(cmds[3].params).toMatchObject({ type: 'keyUp', key: 'Meta', code: 'MetaLeft', modifiers: 0 });
  });

  it('treats Control and Ctrl as the same modifier (bitmask 2)', () => {
    const ctrl = keyEvents('Control+L');
    const ctrlAbbrev = keyEvents('Ctrl+L');
    expect(ctrl[1].params.modifiers).toBe(2);
    expect(ctrlAbbrev[1].params.modifiers).toBe(2);
  });

  it('combines multiple modifiers into a single bitmask (Shift+Meta = 8|4 = 12)', () => {
    const cmds = keyEvents('Shift+Cmd+Z');
    const inner = cmds.find((c) => c.params.code === 'KeyZ');
    expect(inner?.params.modifiers).toBe(12);
  });

  it('throws on an unknown key name', () => {
    expect(() => keyEvents('Frobnicate')).toThrow(/unknown key/i);
  });
});
