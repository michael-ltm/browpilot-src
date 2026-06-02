import { describe, it, expect } from 'vitest';
import { resolve as resolvePath } from 'node:path';
import { resolveBrokerEntry } from '../src/client.js';

describe('resolveBrokerEntry', () => {
  const HERE = '/pkg/dist';
  // Build expected paths with the same resolver the impl uses so they match on
  // Windows (backslashes + drive letter) as well as POSIX.
  const packaged = resolvePath(HERE, 'broker.js'); // published: dist/mcp.js + dist/broker.js
  const dev = resolvePath(HERE, '../../broker/dist/index.js'); // monorepo dev
  it('prefers the co-located packaged broker.js', () => {
    expect(resolveBrokerEntry(HERE, (p) => p === packaged)).toBe(packaged);
  });
  it('falls back to the dev monorepo path', () => {
    expect(resolveBrokerEntry(HERE, (p) => p === dev)).toBe(dev);
  });
  it('throws naming both probed paths when neither exists', () => {
    expect(() => resolveBrokerEntry(HERE, () => false)).toThrow(/broker entry not found/);
  });
});
