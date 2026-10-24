import { describe, expect, it } from 'vitest';
import { routeWithLifecycle } from '../src/lifecycle-rpc.js';

function fixture() {
  const calls: unknown[] = [];
  const lifecycle = {
    list: async () => [{ id: 'local-1' }],
    register: async (p: unknown) => p,
    canResolve: (id: string) => id === 'local-1' || id === 'offline',
    ensure: async () => ({ browserId: 'running', launched: true }),
    openInstall: async () => ({ instructions: 'Confirm in browser' }),
  };
  const router = {
    connectedBrowserIds: () => ['running'],
    routeRequest: async (_session: string, req: unknown) => { calls.push(req); return { jsonrpc: '2.0', id: 1, result: 'ok' }; },
  };
  return { lifecycle, router, calls };
}
describe('lifecycle routing', () => {
  it('lists local instances without requiring an extension connection', async () => {
    const { lifecycle, router } = fixture();
    const result = await routeWithLifecycle(router as never, lifecycle as never, 's', { jsonrpc: '2.0', id: 1, method: 'listLocalInstances' });
    expect(result).toMatchObject({ result: { profiles: [{ id: 'local-1' }] } });
  });
  it('ensures an offline profile before forwarding a command exactly once', async () => {
    const { lifecycle, router, calls } = fixture();
    await routeWithLifecycle(router as never, lifecycle as never, 's', { jsonrpc: '2.0', id: 1, method: 'newTab', params: { browserId: 'offline', url: 'https://example.com' } });
    expect(calls).toEqual([{ jsonrpc: '2.0', id: 1, method: 'newTab', params: { browserId: 'running', url: 'https://example.com' } }]);
  });
  it('returns launch failure without dispatching the command', async () => {
    const { lifecycle, router, calls } = fixture();
    lifecycle.ensure = async () => { throw new Error('Extension disabled'); };
    const result = await routeWithLifecycle(router as never, lifecycle as never, 's', { jsonrpc: '2.0', id: 1, method: 'newTab', params: { browserId: 'offline' } });
    expect(result).toMatchObject({ error: { message: 'Extension disabled' } }); expect(calls).toEqual([]);
  });
  it('rejects malformed registration arguments', async () => {
    const { lifecycle, router } = fixture();
    const result = await routeWithLifecycle(router as never, lifecycle as never, 's', { jsonrpc: '2.0', id: 1, method: 'registerLocalInstance', params: { executable: '/bin/sh' } });
    expect(result).toHaveProperty('error');
  });
});
