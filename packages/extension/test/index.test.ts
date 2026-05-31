import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';
import { Method } from '@claude-browser/shared';
import { RECONNECT_ALARM } from '../src/background/transport';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
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
});
