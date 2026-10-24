import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/load-config.js';
import { DEFAULT_PORT } from '@browpilot/shared';

describe('parseConfig', () => {
  it('reads port/token/extensionId from valid JSON', () => {
    const cfg = parseConfig('{"port":9000,"token":"abc","extensionId":"ext"}');
    expect(cfg).toEqual({ port: 9000, token: 'abc', extensionId: 'ext' });
  });

  it('defaults the port to DEFAULT_PORT when omitted', () => {
    const cfg = parseConfig('{"token":"abc","extensionId":"ext"}');
    expect(cfg.port).toBe(DEFAULT_PORT);
  });

  it('throws a clear error when token is missing', () => {
    expect(() => parseConfig('{"extensionId":"ext"}')).toThrow(/token/i);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseConfig('not json')).toThrow(/config/i);
  });
});
