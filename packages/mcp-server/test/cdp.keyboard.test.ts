import { describe, it, expect } from 'vitest';
import { keyEvents, typeEvents, KEY_MAP } from '../src/cdp.js';

describe('KEY_MAP', () => {
  it('maps Enter to the correct code/keyCode', () => {
    expect(KEY_MAP['Enter']).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  });
  it('maps a letter case-insensitively', () => {
    expect(KEY_MAP['a']).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  });
});

describe('keyEvents', () => {
  it('emits keyDown (with "\\r", so keypress fires and forms submit) then keyUp for Enter', () => {
    const cmds = keyEvents('Enter');
    expect(cmds).toHaveLength(2);
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    expect(cmds[0]!).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' },
    });
    expect(cmds[1]!).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    });
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
  });

  it('wraps a chord with modifier down/up and applies the modifier bitmask to the inner key', () => {
    const cmds = keyEvents('Cmd+A'); // Meta = 4
    // Meta down, A down, A up, Meta up
    expect(cmds).toHaveLength(4);
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    expect(cmds[0]!.params).toMatchObject({ type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
    expect(cmds[1]!.params).toMatchObject({ type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
    expect(cmds[1]!.params.text).toBeUndefined();
    expect(cmds[2]!.params).toMatchObject({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    expect(cmds[3]!.params).toMatchObject({ type: 'keyUp', key: 'Meta', code: 'MetaLeft', modifiers: 0 });
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
  });

  it('treats Control and Ctrl as the same modifier (bitmask 2)', () => {
    const ctrl = keyEvents('Control+L');
    const ctrlAbbrev = keyEvents('Ctrl+L');
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    expect(ctrl[1]!.params.modifiers).toBe(2);
    expect(ctrlAbbrev[1]!.params.modifiers).toBe(2);
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
  });

  it('combines multiple modifiers into a single bitmask (Shift+Meta = 8|4 = 12)', () => {
    const cmds = keyEvents('Shift+Cmd+Z');
    const inner = cmds.find((c) => c.params.code === 'KeyZ');
    expect(inner?.params.modifiers).toBe(12);
  });

  it('sends non-printing keys as rawKeyDown without text', () => {
    expect(keyEvents('Tab')[0]!.params).toMatchObject({ type: 'rawKeyDown', key: 'Tab' });
    expect(keyEvents('Tab')[0]!.params.text).toBeUndefined();
  });

  it('accepts key names case-insensitively and common aliases', () => {
    expect(keyEvents('escape')[0]!.params).toMatchObject({ key: 'Escape' });
    expect(keyEvents('Esc')[0]!.params).toMatchObject({ key: 'Escape' });
    expect(keyEvents('F5')[0]!.params).toMatchObject({ key: 'F5', windowsVirtualKeyCode: 116 });
  });

  it('types a capital for Shift+a, and holds Shift for a lone "A" or "!"', () => {
    expect(keyEvents('Shift+a')[1]!.params).toMatchObject({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 });
    const lone = keyEvents('!');
    expect(lone.map((c) => c.params.key)).toEqual(['Shift', '!', '!', 'Shift']);
    expect(lone[1]!.params).toMatchObject({ code: 'Digit1', text: '!', modifiers: 8 });
  });

  it('maps undo/redo shortcuts to editing commands', () => {
    expect(keyEvents('Control+Z')[1]!.params.commands).toEqual(['undo']);
    expect(keyEvents('Cmd+Shift+Z')[2]!.params.commands).toEqual(['redo']);
    expect(keyEvents('Control+L')[1]!.params.commands).toBeUndefined();
  });

  it('treats a trailing "+" as the plus key', () => {
    expect(keyEvents('Control++')[1]!.params).toMatchObject({ key: '=', code: 'Equal', modifiers: 2 });
    expect(keyEvents('+').map((c) => c.params.key)).toEqual(['Shift', '+', '+', 'Shift']);
  });

  it('throws on an unknown key name', () => {
    expect(() => keyEvents('Frobnicate')).toThrow(/unknown key/i);
  });
});

describe('typeEvents', () => {
  it('types each keyboard character as keyDown(text) + keyUp', () => {
    const cmds = typeEvents('ab');
    expect(cmds.map((c) => [c.params.type, c.params.key])).toEqual([
      ['keyDown', 'a'], ['keyUp', 'a'], ['keyDown', 'b'], ['keyUp', 'b'],
    ]);
    expect(cmds[0]!.params).toMatchObject({ text: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  });

  it('holds Shift around shifted characters', () => {
    const cmds = typeEvents('H@');
    expect(cmds.map((c) => `${c.params.type}:${c.params.key}`)).toEqual([
      'rawKeyDown:Shift', 'keyDown:H', 'keyUp:H', 'keyUp:Shift',
      'rawKeyDown:Shift', 'keyDown:@', 'keyUp:@', 'keyUp:Shift',
    ]);
    expect(cmds[1]!.params).toMatchObject({ modifiers: 8, text: 'H', code: 'KeyH' });
  });

  it('presses Enter for newlines (CRLF included)', () => {
    const keys = typeEvents('a\r\nb').map((c) => c.params.key);
    expect(keys).toEqual(['a', 'a', 'Enter', 'Enter', 'b', 'b']);
  });

  it('commits runs of non-keyboard text through one IME composition', () => {
    const cmds = typeEvents('x你好😀y');
    expect(cmds.map((c) => c.method)).toEqual([
      'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
      'Input.imeSetComposition', 'Input.insertText',
      'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
    ]);
    expect(cmds[2]!.params).toEqual({ text: '你好😀', selectionStart: 4, selectionEnd: 4 });
    expect(cmds[3]!.params).toEqual({ text: '你好😀' });
  });
});
