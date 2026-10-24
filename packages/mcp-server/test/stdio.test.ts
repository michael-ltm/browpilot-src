import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, Method, type JsonRpcRequest } from '@browpilot/shared';
import { Router } from '../../broker/src/router.js';
import { ProfileRegistry } from '../../broker/src/profiles.js';
import { connectStdioSession } from '../src/stdio.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture() {
  const registry = new ProfileRegistry();
  const router = new Router(registry);
  registry.connected('browser', 'Dev 2');
  router.registerBrowser('browser', message => {
    const request = message as JsonRpcRequest;
    queueMicrotask(() => router.handleBrowserMessage('browser', { jsonrpc: '2.0', id: request.id, result: {} }));
  });
  for (const owner of ['ended', 'active', 'next']) router.registerAgent(owner, () => {});
  let id = 0;
  const attach = (owner: string, tabId: number) => router.routeRequest(owner, {
    jsonrpc: '2.0', id: ++id, method: Method.ATTACH, params: { browserId: 'browser', tabId },
  });
  await attach('ended', 10);
  await attach('active', 20);
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer({ name: 'stdio-lifecycle', version: '1' });
  let disposals = 0;
  const close = await connectStdioSession({ server, dispose: () => {
    disposals++;
    router.onAgentDisconnect('ended');
  } }, input, output);
  cleanups.push(close);
  return { input, output, server, close, attach, disposals: () => disposals };
}

describe('stdio session lifetime', () => {
  it('releases the ended caller lease on stdin EOF and preserves another active caller', async () => {
    const f = await fixture();
    expect(await f.attach('next', 10)).toMatchObject({ error: { code: ErrorCode.LEASE_DENIED } });
    f.input.end();
    await vi.waitFor(() => expect(f.disposals()).toBe(1));
    expect(await f.attach('next', 10)).toMatchObject({ result: {} });
    expect(await f.attach('next', 20)).toMatchObject({ error: { code: ErrorCode.LEASE_DENIED } });
  });

  it('closes on destroyed stdin even without an end event', async () => {
    const f = await fixture();
    f.input.destroy();
    await vi.waitFor(() => expect(f.disposals()).toBe(1));
    expect(await f.attach('next', 10)).toMatchObject({ result: {} });
  });

  it('closes when the caller output pipe fails', async () => {
    const f = await fixture();
    f.output.destroy(Object.assign(new Error('caller is gone'), { code: 'EPIPE' }));
    await vi.waitFor(() => expect(f.disposals()).toBe(1));
    expect(await f.attach('next', 10)).toMatchObject({ result: {} });
  });

  it('disposes only once when EOF and explicit shutdown race', async () => {
    const f = await fixture();
    f.input.end();
    await Promise.all([f.close(), f.close(), f.server.close()]);
    expect(f.disposals()).toBe(1);
  });

  it('waits for asynchronous disposal before shutdown resolves', async () => {
    let release!: () => void;
    let started!: () => void;
    const disposing = new Promise<void>(resolve => { started = resolve; });
    const server = new McpServer({ name: 'async-disposal', version: '1' });
    const close = await connectStdioSession({ server, dispose: async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    } }, new PassThrough(), new PassThrough());
    cleanups.push(close);
    let closed = false;
    const closing = close().then(() => { closed = true; });
    await disposing;
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });
});
