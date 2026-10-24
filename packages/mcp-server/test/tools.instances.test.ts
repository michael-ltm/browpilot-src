import { describe, it, expect } from 'vitest';
import { instanceTools } from '../src/tools/instances.js';
import { createContext } from '../src/context.js';

describe('instance tools', () => {
  it('selects the paired browser and clears stale snapshot references after launch', async () => {
    const ctx = createContext({ request: async () => ({ browserId: 'paired', launched: true }) as never });
    ctx.refs.set('ref1', 12);
    await instanceTools.find(t => t.name === 'browser_open_instance')!.handler({ id: 'local-1' }, ctx);
    expect(ctx.selectedBrowserId).toBe('paired'); expect(ctx.refs.size).toBe(0);
  });
  it('exposes install guidance as a tool rather than claiming silent installation', () => {
    expect(instanceTools.find(t => t.name === 'browser_install_extension')!.description).toMatch(/confirm/i);
  });
});
