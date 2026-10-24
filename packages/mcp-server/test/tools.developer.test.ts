import { describe, expect, it } from 'vitest';
import { developerTools } from '../src/tools/developer.js';
import { createContext } from '../src/context.js';

describe('developer tool validation', () => {
  it('does not launch without an explicit executable', async () => {
    const ctx = createContext({ request: async () => ({}) as never });
    await expect(developerTools[0]!.handler({ action: 'launch' }, ctx)).rejects.toThrow(/executable/);
  });
  it('requires a session when selecting extension execution contexts', async () => {
    const ctx = createContext({ request: async () => ({}) as never });
    await expect(developerTools[0]!.handler({ action: 'contexts' }, ctx)).rejects.toThrow(/sessionId/);
  });
});
