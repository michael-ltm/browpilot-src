import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ErrorCode,
  Method,
  Notif,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type OnCdpEventParams,
  type ConsoleEntry,
} from '@claude-browser/shared';
import { ConsoleBuffer } from '../src/buffer.js';
import { Router } from '../src/router.js';

function sent<T extends JsonRpcMessage = JsonRpcMessage>(fn: ReturnType<typeof vi.fn>): T[] {
  return fn.mock.calls.map((c) => c[0] as T);
}

function lastBrowserRequest(browserSend: ReturnType<typeof vi.fn>): JsonRpcRequest {
  const reqs = sent<JsonRpcRequest>(browserSend).filter((m) => 'method' in m && 'id' in m);
  return reqs[reqs.length - 1];
}

describe('Router', () => {
  let buffer: ConsoleBuffer;
  let router: Router;
  let browserSend: ReturnType<typeof vi.fn>;
  let agentSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    buffer = new ConsoleBuffer();
    router = new Router(buffer);
    browserSend = vi.fn();
    agentSend = vi.fn();
  });

  it('rejects agent requests with EXTENSION_DISCONNECTED when no browser is connected', async () => {
    router.registerAgent('sess-1', agentSend);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.GET_TABS };
    const resp = (await router.routeRequest('sess-1', req)) as JsonRpcErrorResponse;
    expect(resp.id).toBe(1);
    expect(resp.error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);
  });

  it('forwards a request to the browser with a fresh correlation id and relays the result', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 'orig-7', method: Method.GET_TABS };
    const pending = router.routeRequest('sess-1', req);

    const fwd = lastBrowserRequest(browserSend);
    expect(fwd.method).toBe(Method.GET_TABS);
    expect(fwd.id).not.toBe('orig-7'); // broker-issued correlation id

    const browserResp: JsonRpcSuccess = { jsonrpc: '2.0', id: fwd.id, result: { tabs: [] } };
    router.handleBrowserMessage(browserResp);

    const resp = (await pending) as JsonRpcSuccess;
    expect(resp.id).toBe('orig-7'); // mapped back to the agent's original id
    expect(resp.result).toEqual({ tabs: [] });
  });

  it('relays a browser error response mapped back to the original id', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 9, method: Method.NEW_TAB, params: {} };
    const pending = router.routeRequest('sess-1', req);
    const fwd = lastBrowserRequest(browserSend);
    const err: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id: fwd.id,
      error: { code: ErrorCode.CDP_ERROR, message: 'boom' },
    };
    router.handleBrowserMessage(err);
    const resp = (await pending) as JsonRpcErrorResponse;
    expect(resp.id).toBe(9);
    expect(resp.error.code).toBe(ErrorCode.CDP_ERROR);
  });

  it('serves GET_CONSOLE locally from the buffer, never forwarding to the browser', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const e: ConsoleEntry = { tabId: 5, level: 'error', text: 'kaboom', timestamp: 100 };
    buffer.push(e);
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'c1',
      method: Method.GET_CONSOLE,
      params: { tabId: 5 },
    };
    const resp = (await router.routeRequest('sess-1', req)) as JsonRpcSuccess<{
      entries: ConsoleEntry[];
    }>;
    expect(resp.id).toBe('c1');
    expect(resp.result.entries).toEqual([e]);
    expect(browserSend).not.toHaveBeenCalled();
  });

  it('grants an ATTACH lease and denies a second session attaching the same tab', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    router.registerAgent('sess-2', vi.fn());

    const attach1: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: Method.ATTACH,
      params: { tabId: 42 },
    };
    const p1 = router.routeRequest('sess-1', attach1);
    const fwd = lastBrowserRequest(browserSend);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: fwd.id, result: {} });
    const r1 = (await p1) as JsonRpcSuccess;
    expect(r1.id).toBe(1);
    expect('error' in r1).toBe(false);

    const attach2: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: Method.ATTACH,
      params: { tabId: 42 },
    };
    const r2 = (await router.routeRequest('sess-2', attach2)) as JsonRpcErrorResponse;
    expect(r2.error.code).toBe(ErrorCode.LEASE_DENIED);
  });

  it('denies EXECUTE_CDP against a tab leased by another session', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    router.registerAgent('sess-2', vi.fn());

    const attach: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: Method.ATTACH,
      params: { tabId: 7 },
    };
    const pa = router.routeRequest('sess-1', attach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pa;

    const exec: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: Method.EXECUTE_CDP,
      params: { target: { tabId: 7 }, method: 'Page.reload' },
    };
    const r = (await router.routeRequest('sess-2', exec)) as JsonRpcErrorResponse;
    expect(r.error.code).toBe(ErrorCode.LEASE_DENIED);
  });

  it('releases a lease on DETACH so another session may then claim it', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const a2 = vi.fn();
    router.registerAgent('sess-2', a2);

    const attach: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 3 } };
    const pa = router.routeRequest('sess-1', attach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pa;

    const detach: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.DETACH, params: { tabId: 3 } };
    const pd = router.routeRequest('sess-1', detach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pd;

    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: Method.ATTACH, params: { tabId: 3 } };
    const pa2 = router.routeRequest('sess-2', attach2);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    const r = (await pa2) as JsonRpcSuccess;
    expect('error' in r).toBe(false);
  });

  it('ingests ON_CDP_EVENT console events into the buffer and fans the notification out to agents', () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const params: OnCdpEventParams = {
      source: { tabId: 11 },
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ value: 'page exploded' }], timestamp: 1234 },
    };
    router.handleBrowserMessage({ jsonrpc: '2.0', method: Notif.ON_CDP_EVENT, params });

    const buffered = buffer.query({ tabId: 11 });
    expect(buffered).toHaveLength(1);
    expect(buffered[0].text).toContain('page exploded');
    expect(buffered[0].level).toBe('error');

    const notifs = sent(agentSend).filter((m) => 'method' in m && !('id' in m));
    expect(notifs.some((m) => (m as { method: string }).method === Notif.ON_CDP_EVENT)).toBe(true);
  });

  it('rejects ALL pending requests with EXTENSION_DISCONNECTED on browser disconnect', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const p1 = router.routeRequest('sess-1', { jsonrpc: '2.0', id: 1, method: Method.GET_TABS });
    const p2 = router.routeRequest('sess-1', { jsonrpc: '2.0', id: 2, method: Method.GET_HISTORY, params: { query: 'x' } });

    router.onBrowserDisconnect();

    const r1 = (await p1) as JsonRpcErrorResponse;
    const r2 = (await p2) as JsonRpcErrorResponse;
    expect(r1.error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);
    expect(r2.error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);

    const notifs = sent(agentSend).filter((m) => 'method' in m && !('id' in m));
    expect(notifs.some((m) => (m as { method: string }).method === Notif.ON_STATUS)).toBe(true);
  });

  it('answers a browser-originated ping request with { pong: true } on the browser link', () => {
    router.registerBrowser(browserSend);
    const pingReq: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.PING };
    router.handleBrowserMessage(pingReq);
    expect(browserSend).toHaveBeenCalledOnce();
    const resp = browserSend.mock.calls[0][0] as JsonRpcSuccess;
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ pong: true });
  });

  it('does NOT claim a lease when the browser returns an error for ATTACH (no phantom lease)', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const a2 = vi.fn();
    router.registerAgent('sess-2', a2);

    // sess-1 ATTACHes tab 55, but the browser responds with an error (e.g. tab not found).
    const attach: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 55 } };
    const pa = router.routeRequest('sess-1', attach);
    const fwd = lastBrowserRequest(browserSend);
    router.handleBrowserMessage({
      jsonrpc: '2.0',
      id: fwd.id,
      error: { code: ErrorCode.CDP_ERROR, message: 'tab not found' },
    });
    const r1 = (await pa) as JsonRpcErrorResponse;
    expect(r1.error.code).toBe(ErrorCode.CDP_ERROR);

    // sess-2 should now be able to ATTACH the same tab — no phantom lease was created.
    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.ATTACH, params: { tabId: 55 } };
    const pa2 = router.routeRequest('sess-2', attach2);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    const r2 = (await pa2) as JsonRpcSuccess;
    expect('error' in r2).toBe(false);
  });

  it('releases leases held by a session when that agent disconnects', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const a2 = vi.fn();
    router.registerAgent('sess-2', a2);

    const attach: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 99 } };
    const pa = router.routeRequest('sess-1', attach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pa;

    router.onAgentDisconnect('sess-1');

    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.ATTACH, params: { tabId: 99 } };
    const pa2 = router.routeRequest('sess-2', attach2);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    const r = (await pa2) as JsonRpcSuccess;
    expect('error' in r).toBe(false);
  });

  it('blocks a concurrent ATTACH from a second session before the first ACK returns (optimistic lease)', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    router.registerAgent('sess-2', vi.fn());

    // Both sessions attempt to ATTACH tab 77 before either browser ACK arrives.
    const attach1: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 77 } };
    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.ATTACH, params: { tabId: 77 } };

    const p1 = router.routeRequest('sess-1', attach1);
    // The second request is issued synchronously before any ACK arrives.
    const p2 = router.routeRequest('sess-2', attach2);

    // Resolve sess-1's pending request with success.
    const fwdReqs = sent<JsonRpcRequest>(browserSend).filter((m) => 'method' in m && 'id' in m);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: fwdReqs[0].id, result: {} });

    const r1 = (await p1) as JsonRpcSuccess;
    expect('error' in r1).toBe(false);

    // sess-2's request should have been denied immediately (LEASE_DENIED), never forwarded.
    const r2 = (await p2) as JsonRpcErrorResponse;
    expect(r2.error.code).toBe(ErrorCode.LEASE_DENIED);
  });

  it('resolves with TIMEOUT if the browser does not respond within the timeout window', async () => {
    vi.useFakeTimers();
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 5, method: Method.GET_TABS };
    const pending = router.routeRequest('sess-1', req);

    // Advance time past the 30 s timeout.
    vi.advanceTimersByTime(31_000);

    const resp = (await pending) as JsonRpcErrorResponse;
    expect(resp.id).toBe(5);
    expect(resp.error.code).toBe(ErrorCode.TIMEOUT);
    vi.useRealTimers();
  });

  it('rolls back an optimistic ATTACH lease when the request times out', async () => {
    vi.useFakeTimers();
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    router.registerAgent('sess-2', vi.fn());

    // sess-1 ATTACHes tab 88; no ACK from browser (simulate silent drop).
    const attach1: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 88 } };
    const p1 = router.routeRequest('sess-1', attach1);

    // Advance past timeout — sess-1's request should time out and roll back the lease.
    vi.advanceTimersByTime(31_000);
    const r1 = (await p1) as JsonRpcErrorResponse;
    expect(r1.error.code).toBe(ErrorCode.TIMEOUT);

    vi.useRealTimers();

    // sess-2 should now be able to claim the tab (no phantom lease).
    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.ATTACH, params: { tabId: 88 } };
    const p2 = router.routeRequest('sess-2', attach2);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    const r2 = (await p2) as JsonRpcSuccess;
    expect('error' in r2).toBe(false);
  });
});
