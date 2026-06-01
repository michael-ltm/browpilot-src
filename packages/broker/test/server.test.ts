import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  Method,
  Notif,
  ErrorCode,
  type Config,
  type AgentHello,
  type BrowserHello,
  type JsonRpcRequest,
  type JsonRpcMessage,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
} from '@claude-browser/shared';
import { startServer, type BrokerServer } from '../src/server.js';

const config: Config = { port: 0, token: 'secret-token', extensionId: 'pinnedextid' };
const ORIGIN = 'chrome-extension://pinnedextid';

let server: BrokerServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

function url(s: BrokerServer): string {
  return `ws://127.0.0.1:${s.port}`;
}

function once<T = JsonRpcMessage>(ws: WebSocket): Promise<T> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as T));
  });
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

async function connectAgent(s: BrokerServer, token: string, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(url(s));
  await open(ws);
  const hello: AgentHello = { type: 'hello', role: 'agent', token, sessionId };
  ws.send(JSON.stringify(hello));
  return ws;
}

async function connectBrowser(
  s: BrokerServer,
  instanceId = 'test-profile',
  label = 'Test',
): Promise<WebSocket> {
  const ws = new WebSocket(url(s), { headers: { Origin: ORIGIN } });
  await open(ws);
  const hello: BrowserHello = { type: 'hello', role: 'browser', extensionId: 'pinnedextid', instanceId, label };
  ws.send(JSON.stringify(hello));
  return ws;
}

describe('broker server', () => {
  it('binds 127.0.0.1 and exposes the chosen ephemeral port', async () => {
    server = await startServer(config);
    expect(server.port).toBeGreaterThan(0);
    expect(server.host).toBe('127.0.0.1');
  });

  it('rejects a websocket upgrade carrying an http origin (DNS-rebinding defense)', async () => {
    server = await startServer(config);
    const ws = new WebSocket(url(server), { headers: { Origin: 'http://evil.example' } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(401));
    });
    expect(code).toBe(401);
  });

  it('closes an agent connection presenting a wrong token with UNAUTHORIZED', async () => {
    server = await startServer(config);
    const ws = new WebSocket(url(server));
    await open(ws);
    const hello: AgentHello = { type: 'hello', role: 'agent', token: 'wrong', sessionId: 's' };
    ws.send(JSON.stringify(hello));
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  it('routes an agent request to the browser and relays the result', async () => {
    server = await startServer(config);
    const browser = await connectBrowser(server);
    const agent = await connectAgent(server, 'secret-token', 'sess-1');

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.GET_TABS };
    agent.send(JSON.stringify(req));

    const fwd = await once<JsonRpcRequest>(browser);
    expect(fwd.method).toBe(Method.GET_TABS);
    const resp: JsonRpcSuccess = { jsonrpc: '2.0', id: fwd.id, result: { tabs: [{ id: 5 }] } };
    browser.send(JSON.stringify(resp));

    const agentResp = await once<JsonRpcSuccess<{ tabs: unknown[] }>>(agent);
    expect(agentResp.id).toBe(1);
    expect(agentResp.result.tabs).toEqual([{ id: 5 }]);
  });

  it('rejects pending agent requests with EXTENSION_DISCONNECTED when the browser drops', async () => {
    server = await startServer(config);
    const browser = await connectBrowser(server);
    const agent = await connectAgent(server, 'secret-token', 'sess-1');

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 7, method: Method.GET_TABS };
    agent.send(JSON.stringify(req));
    await once(browser); // ensure it was forwarded (and thus pending)
    browser.terminate();

    // The agent receives both the EXTENSION_DISCONNECTED response and an ON_PROFILE_CHANGE notif (any order).
    const got = await new Promise<{ err: boolean; status: boolean }>((resolve) => {
      let err = false;
      let status = false;
      agent.on('message', (d) => {
        const m = JSON.parse(d.toString()) as JsonRpcMessage;
        if ('error' in m && (m as JsonRpcErrorResponse).error.code === ErrorCode.EXTENSION_DISCONNECTED) err = true;
        if ('method' in m && (m as { method: string }).method === Notif.ON_PROFILE_CHANGE) status = true;
        if (err && status) resolve({ err, status });
      });
    });
    expect(got.err).toBe(true);
    expect(got.status).toBe(true);
  });

  it('tracks two profiles independently and routes by browserId', async () => {
    server = await startServer(config);
    const b1 = await connectBrowser(server, 'p1', 'One');
    const b2 = await connectBrowser(server, 'p2', 'Two');
    await new Promise((r) => setTimeout(r, 50)); // let both hellos register
    expect(server.hasBrowserConnection()).toBe(true);
    expect(server.router.connectedBrowserIds().sort()).toEqual(['p1', 'p2']);

    const agent = await connectAgent(server, 'secret-token', 'sess-mp');
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 9, method: Method.GET_TABS, params: { browserId: 'p2' } };
    agent.send(JSON.stringify(req));
    // Only p2 should receive the forwarded request.
    const fwd = await once<JsonRpcRequest>(b2);
    expect(fwd.method).toBe(Method.GET_TABS);
    void b1;
  });

  it('keeps a profile routable after a same-instanceId reconnect (stale close must not deregister)', async () => {
    server = await startServer(config);
    await connectBrowser(server, 'rc', 'RC');
    await new Promise((r) => setTimeout(r, 40));
    const b2 = await connectBrowser(server, 'rc', 'RC'); // same instanceId -> replaces the socket
    await new Promise((r) => setTimeout(r, 80)); // let the stale socket's async close fire
    expect(server.router.connectedBrowserIds()).toEqual(['rc']);
    const agent = await connectAgent(server, 'secret-token', 'sess-rc');
    agent.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: Method.GET_TABS, params: { browserId: 'rc' } }));
    const fwd = await once<JsonRpcRequest>(b2);
    expect(fwd.method).toBe(Method.GET_TABS);
  });

  it('terminates a link that fails to pong within a heartbeat tick', async () => {
    server = await startServer(config, { heartbeatMs: 60 });
    const agent = await connectAgent(server, 'secret-token', 'sess-hb');
    // Suppress the auto-pong so the server sees a dead link.
    agent.pong = (() => {}) as unknown as WebSocket['pong'];
    const closed = await new Promise<boolean>((resolve) => {
      agent.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(closed).toBe(true);
  });
});
