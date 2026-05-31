import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrokerClient, type ClientSocket } from '../src/client.js';
import { Method, ErrorCode, Notif, type JsonRpcMessage } from '@claude-browser/shared';

class FakeSocket implements ClientSocket {
  sent: string[] = [];
  private handlers: Record<string, ((arg: unknown) => void)[]> = {};
  on(event: string, cb: (arg: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close', undefined);
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  /** Simulate the server sending us a JSON-RPC message. */
  deliver(msg: JsonRpcMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  lastSent(): JsonRpcMessage {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function connectedClient() {
  const socket = new FakeSocket();
  const client = new BrokerClient({
    port: 8787,
    token: 'tok',
    sessionId: 'sess-1',
    socketFactory: () => socket,
  });
  client.connect();
  socket.emit('open', undefined);
  return { socket, client };
}

describe('BrokerClient handshake', () => {
  it('sends AgentHello as the first message on open', () => {
    const { socket } = connectedClient();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'hello',
      role: 'agent',
      token: 'tok',
      sessionId: 'sess-1',
    });
  });
});

describe('BrokerClient.request', () => {
  beforeEach(() => vi.useRealTimers());

  it('sends a JSON-RPC request with an incrementing numeric id and resolves on matching result', async () => {
    const { socket, client } = connectedClient();
    const p = client.request(Method.GET_TABS, {});
    const req = socket.lastSent();
    expect(req).toMatchObject({ jsonrpc: '2.0', method: 'getTabs', params: {} });
    expect(typeof (req as { id: number }).id).toBe('number');
    const id = (req as { id: number }).id;
    socket.deliver({ jsonrpc: '2.0', id, result: { tabs: [] } });
    await expect(p).resolves.toEqual({ tabs: [] });
  });

  it('rejects with the typed error code carried in a JSON-RPC error response', async () => {
    const { socket, client } = connectedClient();
    const p = client.request(Method.ATTACH, { tabId: 7 });
    const id = (socket.lastSent() as { id: number }).id;
    socket.deliver({ jsonrpc: '2.0', id, error: { code: ErrorCode.TAB_NOT_FOUND, message: 'no tab 7' } });
    await expect(p).rejects.toMatchObject({ code: ErrorCode.TAB_NOT_FOUND, message: 'no tab 7' });
  });

  it('rejects with ErrorCode.TIMEOUT when no response arrives before timeoutMs', async () => {
    vi.useFakeTimers();
    const { client } = connectedClient();
    const p = client.request(Method.PING, {}, 50);
    const assertion = expect(p).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects all pending requests with EXTENSION_DISCONNECTED on socket close', async () => {
    const { socket, client } = connectedClient();
    const p = client.request(Method.GET_TABS, {});
    socket.close();
    await expect(p).rejects.toMatchObject({ code: ErrorCode.EXTENSION_DISCONNECTED });
  });
});

describe('BrokerClient notifications', () => {
  it('dispatches incoming notifications (no id) to onNotification listeners', () => {
    const { socket, client } = connectedClient();
    const seen: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => seen.push({ method, params }));
    socket.deliver({ jsonrpc: '2.0', method: Notif.ON_STATUS, params: { state: 'connected' } });
    expect(seen).toEqual([{ method: Notif.ON_STATUS, params: { state: 'connected' } }]);
  });
});
