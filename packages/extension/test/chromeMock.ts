import { vi } from 'vitest';

/** Records of every alarm created/cleared and the registered onAlarm listeners. */
export interface FakeAlarms {
  created: Record<string, chrome.alarms.AlarmCreateInfo>;
  cleared: string[];
  listeners: Array<(alarm: { name: string }) => void>;
  fire(name: string): void;
}

/** A controllable fake WebSocket recording outbound frames. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalled = true;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // Test drivers:
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** The most recently constructed socket. */
  static latest(): FakeWebSocket {
    const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!s) throw new Error('no FakeWebSocket constructed');
    return s;
  }
  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

export interface ChromeMock {
  chrome: typeof chrome;
  alarms: FakeAlarms;
  storage: Record<string, unknown>;
  /** Email returned by chrome.identity.getProfileUserInfo (''=signed out). */
  identityEmail: string;
  debuggerEvents: Array<(source: chrome.debugger.Debuggee, method: string, params?: object) => void>;
  detachListeners: Array<(source: chrome.debugger.Debuggee, reason: string) => void>;
  /** queued sendCommand resolutions keyed by method */
  sendCommandImpl: (target: chrome.debugger.Debuggee, method: string, params?: object) => Promise<unknown>;
  emitDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void;
  emitDetach(source: chrome.debugger.Debuggee, reason: string): void;
}

export function installChromeMock(): ChromeMock {
  const storage: Record<string, unknown> = {};
  const alarms: FakeAlarms = {
    created: {},
    cleared: [],
    listeners: [],
    fire(name: string) {
      for (const l of this.listeners) l({ name });
    },
  };
  const debuggerEvents: ChromeMock['debuggerEvents'] = [];
  const detachListeners: ChromeMock['detachListeners'] = [];

  const mock: ChromeMock = {
    alarms,
    storage,
    identityEmail: '',
    debuggerEvents,
    detachListeners,
    sendCommandImpl: async () => ({}),
    emitDebuggerEvent(source, method, params) {
      for (const l of debuggerEvents) l(source, method, params);
    },
    emitDetach(source, reason) {
      for (const l of detachListeners) l(source, reason);
    },
    chrome: {} as typeof chrome,
  };

  const chromeObj = {
    runtime: {
      id: 'testextensionid',
      onMessage: { addListener: vi.fn() },
      lastError: undefined as unknown,
      getPlatformInfo: vi.fn((cb?: (info: { os: string; arch: string }) => void) => {
        const info = { os: 'mac', arch: 'arm64' };
        cb?.(info);
        return Promise.resolve(info);
      }),
    },
    alarms: {
      create: vi.fn((name: string, info: chrome.alarms.AlarmCreateInfo) => {
        alarms.created[name] = info;
        return Promise.resolve();
      }),
      clear: vi.fn((name: string) => {
        alarms.cleared.push(name);
        return Promise.resolve(true);
      }),
      onAlarm: {
        addListener: vi.fn((l: (a: { name: string }) => void) => alarms.listeners.push(l)),
      },
    },
    storage: {
      local: {
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(storage, items);
          return Promise.resolve();
        }),
        get: vi.fn((keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in storage) out[k] = storage[k];
          return Promise.resolve(out);
        }),
      },
    },
    debugger: {
      attach: vi.fn(() => Promise.resolve()),
      detach: vi.fn(() => Promise.resolve()),
      sendCommand: vi.fn((target: chrome.debugger.Debuggee, method: string, params?: object) =>
        mock.sendCommandImpl(target, method, params),
      ),
      onEvent: { addListener: vi.fn((l: ChromeMock['debuggerEvents'][number]) => debuggerEvents.push(l)) },
      onDetach: { addListener: vi.fn((l: ChromeMock['detachListeners'][number]) => detachListeners.push(l)) },
    },
    tabs: {
      onUpdated: { addListener: vi.fn() },
      reload: vi.fn(() => Promise.resolve()),
      query: vi.fn(() => Promise.resolve([] as chrome.tabs.Tab[])),
      create: vi.fn((props: chrome.tabs.CreateProperties) =>
        Promise.resolve({ id: 99, url: props.url, active: true, windowId: 1 } as chrome.tabs.Tab),
      ),
      update: vi.fn(() => Promise.resolve({} as chrome.tabs.Tab)),
      remove: vi.fn(() => Promise.resolve()),
    },
    history: {
      search: vi.fn(() => Promise.resolve([] as chrome.history.HistoryItem[])),
    },
    identity: {
      getProfileUserInfo: vi.fn(
        (
          detailsOrCb: unknown,
          maybeCb?: (info: { email: string; id: string }) => void,
        ) => {
          const cb = (typeof detailsOrCb === 'function' ? detailsOrCb : maybeCb) as (info: {
            email: string;
            id: string;
          }) => void;
          cb({ email: mock.identityEmail, id: mock.identityEmail ? 'gaia-test-id' : '' });
        },
      ),
    },
    scripting: {
      executeScript: vi.fn(() => Promise.resolve([])),
    },
  };

  mock.chrome = chromeObj as unknown as typeof chrome;
  (globalThis as { chrome?: typeof chrome }).chrome = mock.chrome;
  return mock;
}

export function installFakeWebSocket(): void {
  FakeWebSocket.reset();
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket as unknown;
}
