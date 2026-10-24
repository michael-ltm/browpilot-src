import { describe, it, expect } from 'vitest';
import { profileTools } from '../src/tools/profiles.js';
import { createContext } from '../src/context.js';
import { Method } from '@browpilot/shared';

function fakeClient(responses: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = [];
  return { calls, request: async <R>(m: string, p?: unknown): Promise<R> => { calls.push([m, p]); return responses[m] as R; } };
}
const byName = (n: string) => profileTools.find((t) => t.name === n)!;

describe('profile tools', () => {
  it('browser_list_profiles renders connected profiles', async () => {
    const client = fakeClient({ [Method.LIST_PROFILES]: { profiles: [{ browserId: 'a', label: 'Work', status: 'connected', reconnectCount: 0, tabCount: 2 }] } });
    const ctx = createContext(client);
    const res = await byName('browser_list_profiles').handler({}, ctx);
    expect(JSON.stringify(res.content)).toContain('Work');
    expect(JSON.stringify(res.content)).toContain('a');
  });

  it('browser_select_profile resolves by label and remembers it', async () => {
    const client = fakeClient({ [Method.LIST_PROFILES]: { profiles: [{ browserId: 'id-1', label: 'Work', status: 'connected', reconnectCount: 0, tabCount: 0 }] } });
    const ctx = createContext(client);
    await byName('browser_select_profile').handler({ label: 'Work' }, ctx);
    expect(ctx.selectedBrowserId).toBe('id-1');
  });

  it('browser_status calls GET_PROFILE_STATUS', async () => {
    const client = fakeClient({ [Method.GET_PROFILE_STATUS]: { profiles: [] } });
    const ctx = createContext(client);
    await byName('browser_status').handler({}, ctx);
    expect(client.calls[0]![0]).toBe(Method.GET_PROFILE_STATUS);
  });
});
