import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startHttpMcp } from '../src/http.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const token = 'a'.repeat(48);
async function fixture() {
  let disposed = 0;
  const server = await startHttpMcp({ port: 0, token, createSession: () => {
    const mcp = new McpServer({ name: 'test', version: '1' });
    let selected = '';
    mcp.registerTool('select', { inputSchema: { name: z.string().optional() } }, async ({ name }) => {
      if (name) selected = name;
      return { content: [{ type: 'text', text: selected }] };
    });
    return { server: mcp, dispose: () => { disposed++; } };
  } });
  cleanups.push(server.close);
  return { url: `http://127.0.0.1:${server.port}/mcp`, disposed: () => disposed };
}
async function post(url: string, body: unknown, session?: string) {
  return fetch(url, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } : {}),
  }, body: JSON.stringify(body) });
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

describe('HTTP MCP', () => {
  it('waits for asynchronous session disposal before closing the server', async () => {
    let finish!: () => void;
    let started!: () => void;
    const disposing = new Promise<void>(resolve => { started = resolve; });
    const server = await startHttpMcp({ port: 0, token, createSession: () => ({ server: new McpServer({ name: 'test', version: '1' }), dispose: async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); } }) });
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const id = (await post(url, init)).headers.get('mcp-session-id')!;
    const removed = fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': id } });
    await disposing;
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    finish(); await closing; await removed;
  });
  it('requires auth before creating any MCP sessions', async () => {
    const { url } = await fixture();
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(init) })).status).toBe(401);
  });
  it('isolates profile state and disposes sessions on DELETE', async () => {
    const { url, disposed } = await fixture();
    const a = (await post(url, init)).headers.get('mcp-session-id')!;
    const b = (await post(url, init)).headers.get('mcp-session-id')!;
    expect(a).toBeTruthy(); expect(b).not.toBe(a);
    await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'select', arguments: { name: 'Work' } } }, a);
    const response = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'select', arguments: {} } }, b);
    expect((await response.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toBe('');
    const removed = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': a } });
    expect(removed.status).toBe(200); expect(disposed()).toBe(1);
    expect((await post(url, init, a)).status).toBe(404);
  });
  it('rejects untrusted browser origins even with an auth header', async () => {
    const { url } = await fixture();
    expect((await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('rejects short bearer secrets', async () => {
    await expect(startHttpMcp({ port: 0, token: 'weak', createSession: () => { throw new Error('unused'); } })).rejects.toThrow(/32/);
  });
});
