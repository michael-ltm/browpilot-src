import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, installFakeWebSocket, FakeWebSocket, type ChromeMock } from './chromeMock';
import { ErrorCode, Method } from '@claude-browser/shared';

let mock: ChromeMock;

beforeEach(() => {
  vi.useFakeTimers();
  mock = installChromeMock();
  installFakeWebSocket();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadTransport() {
  const mod = await import('../src/background/transport');
  return mod;
}

function lastFrame(ws: FakeWebSocket): unknown {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

describe('Transport', () => {
  it('sends a BrowserHello first on open and mirrors connected status', async () => {
    const { Transport, RECONNECT_ALARM } = await loadTransport();
    expect(RECONNECT_ALARM).toBeTypeOf('string');
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    expect(ws.url).toBe('ws://127.0.0.1:8787');
    ws.emitOpen();
    const hello = JSON.parse(ws.sent[0]);
    expect(hello).toEqual({ type: 'hello', role: 'browser', extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    expect(mock.storage.claudeBrowserStatus).toMatchObject({ state: 'connected' });
  });

  it('correlates request ids and resolves with the result', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    const p = t.sendRequest('ping', { hi: 1 });
    const req = lastFrame(ws) as { id: number; method: string; params: unknown };
    expect(req.method).toBe('ping');
    expect(req.params).toEqual({ hi: 1 });
    ws.emitMessage({ jsonrpc: '2.0', id: req.id, result: { pong: true } });
    await expect(p).resolves.toEqual({ pong: true });
  });

  it('rejects a request when an error response arrives', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    const p = t.sendRequest('ping');
    const req = lastFrame(ws) as { id: number };
    ws.emitMessage({ jsonrpc: '2.0', id: req.id, error: { code: ErrorCode.CDP_ERROR, message: 'boom' } });
    await expect(p).rejects.toMatchObject({ code: ErrorCode.CDP_ERROR, message: 'boom' });
  });

  it('dispatches inbound requests to registered handlers and replies with success', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.registerHandler('getTabs', async () => ({ tabs: [{ id: 1 }] }));
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    ws.emitMessage({ jsonrpc: '2.0', id: 7, method: 'getTabs' });
    await vi.advanceTimersByTimeAsync(0);
    const reply = JSON.parse(ws.sent[0]) as { id: number; result: unknown };
    expect(reply.id).toBe(7);
    expect(reply.result).toEqual({ tabs: [{ id: 1 }] });
  });

  it('replies with a JSON-RPC error when a handler throws', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.registerHandler('getTabs', async () => {
      throw { code: ErrorCode.CDP_ERROR, message: 'nope' };
    });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    ws.emitMessage({ jsonrpc: '2.0', id: 8, method: 'getTabs' });
    await vi.advanceTimersByTimeAsync(0);
    const reply = JSON.parse(ws.sent[0]) as { id: number; error: { code: number } };
    expect(reply.id).toBe(8);
    expect(reply.error.code).toBe(ErrorCode.CDP_ERROR);
  });

  it('rejects all pending and schedules BOTH a setTimeout and an alarm on close', async () => {
    const { Transport, RECONNECT_ALARM } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    const p = t.sendRequest('ping');
    ws.emitClose();
    await expect(p).rejects.toMatchObject({ code: ErrorCode.EXTENSION_DISCONNECTED });
    // Alarm scheduled with the survives-SW-death period:
    expect(mock.alarms.created[RECONNECT_ALARM]).toEqual({ periodInMinutes: 0.5 });
    expect(mock.storage.claudeBrowserStatus).toMatchObject({ state: 'reconnecting' });
    // setTimeout retry also scheduled: advancing 5s constructs a brand-new socket.
    const before = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('reports "waiting" (not "reconnecting") when it closes before ever connecting', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitClose(); // broker down / no Claude session: socket never opened
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.storage.claudeBrowserStatus).toMatchObject({ state: 'waiting' });
  });

  it('sends a heartbeat ping at 30s and forces reconnect when no pong in 3s', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    await vi.advanceTimersByTimeAsync(30000);
    const ping = JSON.parse(ws.sent[0]) as { method: string };
    expect(ping.method).toBe(Method.PING);
    expect(ws.closeCalled).toBe(false);
    // No pong arrives within 3s -> the socket is torn down.
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.closeCalled).toBe(true);
  });

  it('does not force reconnect when a pong arrives in time', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid', instanceId: 'test', label: 'Test' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    await vi.advanceTimersByTimeAsync(30000);
    const ping = JSON.parse(ws.sent[0]) as { id: number };
    ws.emitMessage({ jsonrpc: '2.0', id: ping.id, result: { pong: true } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.closeCalled).toBe(false);
  });
});
