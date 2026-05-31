import { describe, it, expect } from 'vitest';
import { insertTextCmd, screenshotParams } from '../src/cdp.js';

describe('insertTextCmd', () => {
  it('builds Input.insertText with the given text', () => {
    expect(insertTextCmd('hello world')).toEqual({
      method: 'Input.insertText',
      params: { text: 'hello world' },
    });
  });
});

describe('screenshotParams', () => {
  it('defaults to png with no clip when fullPage is false', () => {
    expect(screenshotParams(false)).toEqual({ format: 'png', captureBeyondViewport: false });
  });
  it('captures beyond viewport when fullPage is true', () => {
    expect(screenshotParams(true)).toEqual({ format: 'png', captureBeyondViewport: true });
  });
});
