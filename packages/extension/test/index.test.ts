import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, installFakeWebSocket, type ChromeMock } from './chromeMock';
import { Method } from '@claude-browser/shared';
import { RECONNECT_ALARM, KEEPALIVE_ALARM, KEEPALIVE_PERIOD_MIN } from '../src/background/transport';
import { IDLE_DETACH_MIN_KEY } from '../src/background/config';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
  // Importing src/background/index runs its top-level `void main()`, which calls
  // transport.connect() -> `new WebSocket(...)`. Node 20 has no global WebSocket
  // (Node 22 does), so install the fake first to avoid a ReferenceError in CI.
  installFakeWebSocket();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeFakeTransport() {
  const handlers = new Map<string, (p: unknown) => unknown>();
  return {
    handlers,
    connectCount: 0,
    registerHandler: vi.fn((m: string, fn: (p: unknown) => unknown) => handlers.set(m, fn)),
    onNotification: vi.fn(),
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
    connect: vi.fn(function (this: { connectCount: number }) {
      // counted via the wrapper below
    }),
  };
}

describe('background/index bootstrap', () => {
  it('registers every contract method handler and eager-connects', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    for (const m of [
      Method.EXECUTE_CDP,
      Method.ATTACH,
      Method.DETACH,
      Method.GET_TABS,
      Method.NEW_TAB,
      Method.SWITCH_TAB,
      Method.CLOSE_TAB,
      Method.GET_HISTORY,
      Method.PING,
    ]) {
      expect(t.handlers.has(m)).toBe(true);
    }
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it('PING handler returns a pong', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    const ping = t.handlers.get(Method.PING)!;
    expect(await ping(undefined)).toEqual({ pong: true });
  });

  it('the reconnect alarm triggers transport.connect()', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    expect(t.connect).toHaveBeenCalledTimes(1);
    mock.alarms.fire(RECONNECT_ALARM);
    expect(t.connect).toHaveBeenCalledTimes(2);
  });

  it('an unrelated alarm does NOT trigger reconnect', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    mock.alarms.fire('some-other-alarm');
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it('arms a persistent keepalive watchdog alarm at startup', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    expect(mock.alarms.created[KEEPALIVE_ALARM]).toEqual({ periodInMinutes: KEEPALIVE_PERIOD_MIN });
  });

  it('the keepalive alarm triggers transport.connect()', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    expect(t.connect).toHaveBeenCalledTimes(1);
    mock.alarms.fire(KEEPALIVE_ALARM);
    expect(t.connect).toHaveBeenCalledTimes(2);
  });

  it('the keepalive alarm runs an idle-detach sweep (reads the timeout setting)', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    const get = mock.chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    get.mockClear();
    mock.alarms.fire(KEEPALIVE_ALARM);
    await Promise.resolve();
    await Promise.resolve();
    expect(get).toHaveBeenCalledWith(IDLE_DETACH_MIN_KEY);
  });

  it('never clears the keepalive watchdog (survives an abrupt SW death)', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    expect(mock.alarms.cleared).not.toContain(KEEPALIVE_ALARM);
  });

  it('pings a chrome API under 30s to keep the worker from suspending', async () => {
    vi.useFakeTimers();
    try {
      const { bootstrap } = await import('../src/background/index');
      const t = makeFakeTransport();
      const ping = mock.chrome.runtime.getPlatformInfo as unknown as ReturnType<typeof vi.fn>;
      ping.mockClear();
      bootstrap(t as never);
      vi.advanceTimersByTime(25_000);
      expect(ping.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
