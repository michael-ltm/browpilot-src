import { describe, it, expect } from 'vitest';
import { resolveBrokerEntry } from '../src/client.js';

describe('resolveBrokerEntry', () => {
  const HERE = '/pkg/dist';
  it('prefers the co-located packaged broker.js', () => {
    const exists = (p: string) => p === '/pkg/dist/broker.js';
    expect(resolveBrokerEntry(HERE, exists)).toBe('/pkg/dist/broker.js');
  });
  it('falls back to the dev monorepo path', () => {
    const exists = (p: string) => p.endsWith('broker/dist/index.js');
    expect(resolveBrokerEntry(HERE, exists)).toContain('broker/dist/index.js');
  });
  it('throws naming both probed paths when neither exists', () => {
    expect(() => resolveBrokerEntry(HERE, () => false)).toThrow(/broker entry not found/);
  });
});
