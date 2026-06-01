# Multi-Profile Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let several Chrome profiles each run the extension and connect to the broker at once; let Claude Code pick which profile to drive via a native picker (only when ambiguous, remembered per session); and expose per-profile connection status, error logs, and reconnect state.

**Architecture:** The broker's single `browserSocket`/single-browser `Router` become **`browserId`-keyed multi-browser** structures, plus a new `ProfileRegistry` holding per-profile metadata + an event ring buffer. Each extension install carries a stable `instanceId` (= the agent-facing `browserId`) and a user `label`. The MCP layer injects a resolved `browserId` into every browser-bound request; when more than one profile is connected and none is selected, the broker answers `AMBIGUOUS_PROFILE` and the agent disambiguates with a native `AskUserQuestion`.

**Tech Stack:** TypeScript (strict, ESM), npm-workspaces, vitest, `ws`, `@modelcontextprotocol/sdk`. Spec: `docs/superpowers/specs/2026-06-01-multi-profile-support-design.md`.

**Build order (strict):** M-A Protocol → M-B Broker (registry → router → server) → M-C Extension → M-D MCP → M-E Integration. Run from repo root `/Users/ming/Documents/code/ai/claude-ext`. Branch: `feat/multi-profile`.

**Conventions:** All cross-package symbols come from `@claude-browser/shared`. `browserId` is the extension's `instanceId`. Tests are vitest; run a package's tests with `npm test -w @claude-browser/<pkg>`. Commit after each task with the message shown.

---

# Milestone A — Protocol (`@claude-browser/shared`)

### Task 1: Extend the wire contract for profiles

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/test/protocol.test.ts`

- [ ] **Step 1: Add the failing test** — append to `packages/shared/test/protocol.test.ts`:

```ts
import { Method, Notif, ErrorCode } from '../src/protocol.js';

describe('multi-profile contract', () => {
  it('adds profile methods, notif, and error code', () => {
    expect(Method.LIST_PROFILES).toBe('listProfiles');
    expect(Method.GET_PROFILE_STATUS).toBe('getProfileStatus');
    expect(Method.GET_PROFILE_LOGS).toBe('getProfileLogs');
    expect(Notif.ON_PROFILE_CHANGE).toBe('onProfileChange');
    expect(ErrorCode.AMBIGUOUS_PROFILE).toBe(1008);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npm test -w @claude-browser/shared`
Expected: FAIL — `Method.LIST_PROFILES` is undefined.

- [ ] **Step 3: Edit `packages/shared/src/protocol.ts`** — apply these exact changes:

In `ErrorCode`, add `AMBIGUOUS_PROFILE: 1008` to the app-specific line:
```ts
  EXTENSION_DISCONNECTED: 1001, TAB_NOT_FOUND: 1002, STALE_REF: 1003, CDP_ERROR: 1004, LEASE_DENIED: 1005, TIMEOUT: 1006, UNAUTHORIZED: 1007, AMBIGUOUS_PROFILE: 1008,
```

In `Method`, add the three broker-local methods:
```ts
  GET_CONSOLE: 'getConsole', PING: 'ping',
  LIST_PROFILES: 'listProfiles', GET_PROFILE_STATUS: 'getProfileStatus', GET_PROFILE_LOGS: 'getProfileLogs',
```

In `Notif`, add `ON_PROFILE_CHANGE`:
```ts
export const Notif = { ON_CDP_EVENT: 'onCDPEvent', ON_CONSOLE: 'onConsole', ON_STATUS: 'onStatus', ON_PROFILE_CHANGE: 'onProfileChange' } as const;
```

Add `browserId?: string` to every browser-bound param interface (the broker routes on it). Replace those interfaces with:
```ts
export interface ExecuteCdpParams { target: CdpTarget; method: string; params?: Record<string, unknown>; timeoutMs?: number; browserId?: string; }
export interface AttachParams { tabId: number; browserId?: string; }
export interface DetachParams { tabId: number; browserId?: string; }
export interface GetTabsParams { browserId?: string; }
export interface NewTabParams { url?: string; browserId?: string; }
export interface SwitchTabParams { tabId: number; browserId?: string; }
export interface CloseTabParams { tabId: number; browserId?: string; }
export interface GetHistoryParams { query: string; limit?: number; browserId?: string; }
export interface GetConsoleParams { tabId?: number; filter?: string; since?: number; browserId?: string; }
```

Extend `BrowserHello` with identity:
```ts
export interface BrowserHello { type: 'hello'; role: 'browser'; extensionId: string; instanceId: string; label: string; }
```

Append the new profile types at the end of the file (before `Config`):
```ts
export type ProfileStatus = 'connected' | 'disconnected' | 'reconnecting';
export interface ProfileInfo {
  browserId: string;
  label: string;
  status: ProfileStatus;
  connectedAt: number;
  lastSeen: number;
  lastError?: { message: string; at: number };
  reconnectCount: number;
  tabCount: number;
}
export interface ProfileEvent { at: number; kind: 'connect' | 'disconnect' | 'error' | 'reconnect'; detail?: string; }
export interface ListProfilesResult { profiles: ProfileInfo[]; }
export interface GetProfileStatusParams { browserId?: string; }
export interface GetProfileLogsParams { browserId?: string; limit?: number; }
export interface GetProfileLogsResult { events: ProfileEvent[]; }
export interface AmbiguousProfileData { profiles: ProfileInfo[]; }
export interface OnProfileChangeParams extends ProfileInfo {}
```

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `npm test -w @claude-browser/shared && npm run typecheck -w @claude-browser/shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): multi-profile protocol (browserId, profile methods, AMBIGUOUS_PROFILE)"
```

---

# Milestone B — Broker

### Task 2: `ProfileRegistry` — per-profile metadata + event log

**Files:**
- Create: `packages/broker/src/profiles.ts`
- Test: `packages/broker/test/profiles.test.ts`

- [ ] **Step 1: Write the failing test** `packages/broker/test/profiles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ProfileRegistry } from '../src/profiles.js';

function fixedClock() { let t = 1000; return () => (t += 1000); }

describe('ProfileRegistry', () => {
  it('records a new profile as connected with reconnectCount 0', () => {
    const r = new ProfileRegistry(fixedClock());
    expect(r.connected('id-a', 'Work')).toBe(false); // false = not a reconnect
    const info = r.get('id-a')!;
    expect(info).toMatchObject({ browserId: 'id-a', label: 'Work', status: 'connected', reconnectCount: 0, tabCount: 0 });
    expect(r.logs('id-a').map((e) => e.kind)).toEqual(['connect']);
  });

  it('treats same-id reconnect as reconnect and increments the count', () => {
    const r = new ProfileRegistry(fixedClock());
    r.connected('id-a', 'Work');
    r.disconnected('id-a');
    expect(r.connected('id-a', 'Work')).toBe(true);
    expect(r.get('id-a')!.reconnectCount).toBe(1);
    expect(r.logs('id-a').map((e) => e.kind)).toEqual(['connect', 'disconnect', 'reconnect']);
  });

  it('records errors and lists only what was registered', () => {
    const r = new ProfileRegistry(fixedClock());
    r.connected('id-a', 'A'); r.connected('id-b', 'B');
    r.recordError('id-a', 'boom');
    expect(r.get('id-a')!.lastError!.message).toBe('boom');
    expect(r.list().map((p) => p.browserId).sort()).toEqual(['id-a', 'id-b']);
    expect(r.connectedIds().sort()).toEqual(['id-a', 'id-b']);
  });

  it('caps the event log at 50 entries (keeps the most recent)', () => {
    const r = new ProfileRegistry(fixedClock());
    r.connected('id-a', 'A');
    for (let i = 0; i < 60; i++) r.recordError('id-a', `e${i}`);
    const logs = r.logs('id-a');
    expect(logs.length).toBe(50);
    expect(logs.at(-1)!.detail).toBe('e59');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npm test -w @claude-browser/broker -- profiles` → cannot find `../src/profiles.js`.

- [ ] **Step 3: Create `packages/broker/src/profiles.ts`:**

```ts
import type { ProfileInfo, ProfileEvent, ProfileStatus } from '@claude-browser/shared';

const MAX_EVENTS = 50;

interface ProfileRecord {
  browserId: string;
  label: string;
  status: ProfileStatus;
  connectedAt: number;
  lastSeen: number;
  lastError?: { message: string; at: number };
  reconnectCount: number;
  tabCount: number;
  events: ProfileEvent[];
}

/** Tracks per-profile connection metadata and a bounded event log. */
export class ProfileRegistry {
  private readonly records = new Map<string, ProfileRecord>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Mark a profile connected. Returns true if this was a reconnect of a known id. */
  connected(browserId: string, label: string): boolean {
    const t = this.now();
    const existing = this.records.get(browserId);
    if (existing) {
      existing.label = label;
      existing.status = 'connected';
      existing.connectedAt = t;
      existing.lastSeen = t;
      existing.reconnectCount += 1;
      this.pushEvent(existing, 'reconnect');
      return true;
    }
    const rec: ProfileRecord = {
      browserId, label, status: 'connected', connectedAt: t, lastSeen: t,
      reconnectCount: 0, tabCount: 0, events: [],
    };
    this.records.set(browserId, rec);
    this.pushEvent(rec, 'connect');
    return false;
  }

  disconnected(browserId: string): void {
    const r = this.records.get(browserId);
    if (!r) return;
    r.status = 'disconnected';
    r.lastSeen = this.now();
    this.pushEvent(r, 'disconnect');
  }

  recordError(browserId: string, message: string): void {
    const r = this.records.get(browserId);
    if (!r) return;
    const at = this.now();
    r.lastError = { message, at };
    r.lastSeen = at;
    this.pushEvent(r, 'error', message);
  }

  touch(browserId: string): void {
    const r = this.records.get(browserId);
    if (r) r.lastSeen = this.now();
  }

  setTabCount(browserId: string, n: number): void {
    const r = this.records.get(browserId);
    if (r) r.tabCount = n;
  }

  list(): ProfileInfo[] {
    return [...this.records.values()].map(toInfo);
  }

  get(browserId: string): ProfileInfo | undefined {
    const r = this.records.get(browserId);
    return r ? toInfo(r) : undefined;
  }

  logs(browserId: string, limit: number = MAX_EVENTS): ProfileEvent[] {
    const r = this.records.get(browserId);
    return r ? r.events.slice(-limit) : [];
  }

  connectedIds(): string[] {
    return [...this.records.values()].filter((r) => r.status === 'connected').map((r) => r.browserId);
  }

  private pushEvent(r: ProfileRecord, kind: ProfileEvent['kind'], detail?: string): void {
    r.events.push(detail !== undefined ? { at: this.now(), kind, detail } : { at: this.now(), kind });
    if (r.events.length > MAX_EVENTS) r.events.shift();
  }
}

function toInfo(r: ProfileRecord): ProfileInfo {
  return {
    browserId: r.browserId, label: r.label, status: r.status,
    connectedAt: r.connectedAt, lastSeen: r.lastSeen, lastError: r.lastError,
    reconnectCount: r.reconnectCount, tabCount: r.tabCount,
  };
}
```

- [ ] **Step 4: Run tests, expect PASS** — `npm test -w @claude-browser/broker -- profiles`.
- [ ] **Step 5: Commit** — `git add packages/broker && git commit -m "feat(broker): ProfileRegistry (per-profile status + event log)"`

---

### Task 3: `Router` → multi-browser (keyed by `browserId`)

**Files:**
- Modify (rewrite): `packages/broker/src/router.ts`
- Modify: `packages/broker/test/router.test.ts`

This rewrites the Router to hold `Map<browserId, Send>` instead of one `browserSend`, keys `pending`/`leases`/console-buffers by `browserId`, resolves the target browser (explicit → sole → `AMBIGUOUS_PROFILE`), serves the profile methods locally, tags browser notifications with `browserId`, and isolates per-profile disconnect.

- [ ] **Step 1: Replace `packages/broker/src/router.ts` entirely with:**

```ts
import {
  ErrorCode,
  Method,
  Notif,
  type JsonRpcRequest,
  type JsonRpcMessage,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type ExecuteCdpParams,
  type AttachParams,
  type DetachParams,
  type GetConsoleParams,
  type GetConsoleResult,
  type GetProfileLogsParams,
  type GetProfileLogsResult,
  type ListProfilesResult,
  type OnCdpEventParams,
  type ConsoleEntry,
} from '@claude-browser/shared';
import { ConsoleBuffer } from './buffer.js';
import type { ProfileRegistry } from './profiles.js';

type Send = (msg: JsonRpcMessage) => void;
const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  originalId: number | string;
  sessionId: string;
  browserId: string;
  resolve: (msg: JsonRpcMessage) => void;
  method: string;
  params: unknown;
  timer: ReturnType<typeof setTimeout>;
}

function errorResponse(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return data !== undefined
    ? { jsonrpc: '2.0', id, error: { code, message, data } }
    : { jsonrpc: '2.0', id, error: { code, message } };
}

const CONSOLE_CDP_METHODS = new Set(['Runtime.consoleAPICalled', 'Log.entryAdded']);
function toConsoleEntry(p: OnCdpEventParams): ConsoleEntry | null {
  if (!CONSOLE_CDP_METHODS.has(p.method)) return null;
  const tabId = p.source.tabId;
  if (typeof tabId !== 'number') return null;
  const raw = p.params as Record<string, unknown>;
  if (p.method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(raw.args) ? (raw.args as Array<Record<string, unknown>>) : [];
    const text = args
      .map((a) => (a && 'value' in a ? String(a.value) : a && 'description' in a ? String(a.description) : ''))
      .join(' ')
      .trim();
    return { tabId, level: typeof raw.type === 'string' ? raw.type : 'log', text,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(), args: args as unknown[] };
  }
  const entry = (raw.entry ?? {}) as Record<string, unknown>;
  return { tabId, level: typeof entry.level === 'string' ? entry.level : 'log',
    text: typeof entry.text === 'string' ? entry.text : '',
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    url: typeof entry.url === 'string' ? entry.url : undefined };
}

function browserIdOf(params: unknown): string | undefined {
  if (params && typeof params === 'object' && 'browserId' in params) {
    const v = (params as { browserId?: unknown }).browserId;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
function leaseKey(browserId: string, tabId: number): string {
  return `${browserId} ${tabId}`;
}

/**
 * Multi-browser router. Holds one Send per connected profile (browserId), one
 * console buffer per profile, browserId-keyed leases, and a single pending map
 * whose entries carry their target browserId so a profile's disconnect rejects
 * only its own in-flight requests. Profile metadata lives in the ProfileRegistry.
 */
export class Router {
  private readonly browsers = new Map<string, Send>();
  private readonly buffers = new Map<string, ConsoleBuffer>();
  private readonly agents = new Map<string, Send>();
  private readonly pending = new Map<number, Pending>();
  /** leaseKey(browserId, tabId) -> owning sessionId */
  private readonly leases = new Map<string, string>();
  private nextCorrelationId = 1;

  constructor(private readonly registry: ProfileRegistry) {}

  registerBrowser(browserId: string, send: Send): void {
    this.browsers.set(browserId, send);
    if (!this.buffers.has(browserId)) this.buffers.set(browserId, new ConsoleBuffer());
  }
  registerAgent(sessionId: string, send: Send): void {
    this.agents.set(sessionId, send);
  }
  hasBrowser(): boolean { return this.browsers.size > 0; }
  connectedBrowserIds(): string[] { return [...this.browsers.keys()]; }

  /** Emit an onProfileChange notification for a profile (called by the server). */
  announceProfileChange(browserId: string): void {
    const info = this.registry.get(browserId);
    if (info) this.broadcastToAgents({ jsonrpc: '2.0', method: Notif.ON_PROFILE_CHANGE, params: info });
  }

  routeRequest(sessionId: string, req: JsonRpcRequest): Promise<JsonRpcMessage> {
    // Broker-local: profile introspection.
    if (req.method === Method.LIST_PROFILES) {
      const result: ListProfilesResult = { profiles: this.registry.list() };
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, result });
    }
    if (req.method === Method.GET_PROFILE_STATUS) {
      const bid = browserIdOf(req.params);
      const result = bid ? (this.registry.get(bid) ?? null) : { profiles: this.registry.list() };
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, result });
    }
    if (req.method === Method.GET_PROFILE_LOGS) {
      const p = (req.params ?? {}) as GetProfileLogsParams;
      const resolved = this.resolveBrowserId(p.browserId, req.id);
      if ('error' in resolved) return Promise.resolve(resolved.error);
      const result: GetProfileLogsResult = { events: this.registry.logs(resolved.browserId, p.limit) };
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, result });
    }

    const resolved = this.resolveBrowserId(browserIdOf(req.params), req.id);
    if ('error' in resolved) return Promise.resolve(resolved.error);
    const browserId = resolved.browserId;

    // Broker-local: console reads come from that profile's buffer.
    if (req.method === Method.GET_CONSOLE) {
      const params = (req.params ?? {}) as GetConsoleParams;
      const buf = this.buffers.get(browserId);
      const result: GetConsoleResult = { entries: buf ? buf.query(params) : [] };
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, result });
    }

    const leaseError = this.checkLease(sessionId, browserId, req);
    if (leaseError) return Promise.resolve(leaseError);

    const send = this.browsers.get(browserId);
    if (!send) {
      return Promise.resolve(errorResponse(req.id, ErrorCode.EXTENSION_DISCONNECTED, `profile ${browserId} not connected`));
    }

    const correlationId = this.nextCorrelationId++;
    const forwarded: JsonRpcRequest = { jsonrpc: '2.0', id: correlationId, method: req.method, params: req.params };

    return new Promise<JsonRpcMessage>((resolve) => {
      this.applyLeaseSideEffects(sessionId, browserId, req.method, req.params);
      const timer = setTimeout(() => {
        if (this.pending.delete(correlationId)) {
          this.rollbackAttachLease(sessionId, browserId, req.method, req.params);
          resolve(errorResponse(req.id, ErrorCode.TIMEOUT, 'browser did not respond in time'));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(correlationId, { originalId: req.id, sessionId, browserId, resolve, method: req.method, params: req.params, timer });
      send(forwarded);
    });
  }

  /** Resolve which profile a request targets. */
  private resolveBrowserId(
    explicit: string | undefined,
    reqId: number | string,
  ): { browserId: string } | { error: JsonRpcErrorResponse } {
    if (explicit !== undefined) return { browserId: explicit };
    const ids = [...this.browsers.keys()];
    if (ids.length === 1) return { browserId: ids[0]! };
    if (ids.length === 0) return { error: errorResponse(reqId, ErrorCode.EXTENSION_DISCONNECTED, 'no browser profile connected') };
    return { error: errorResponse(reqId, ErrorCode.AMBIGUOUS_PROFILE, 'multiple profiles connected; specify browserId', { profiles: this.registry.list() }) };
  }

  private checkLease(sessionId: string, browserId: string, req: JsonRpcRequest): JsonRpcErrorResponse | null {
    if (req.method === Method.ATTACH) {
      const { tabId } = (req.params ?? {}) as AttachParams;
      const owner = this.leases.get(leaseKey(browserId, tabId));
      if (owner !== undefined && owner !== sessionId) return errorResponse(req.id, ErrorCode.LEASE_DENIED, `tab ${tabId} leased by another session`);
      return null;
    }
    if (req.method === Method.EXECUTE_CDP) {
      const { target } = (req.params ?? {}) as ExecuteCdpParams;
      const tabId = target?.tabId;
      if (typeof tabId === 'number') {
        const owner = this.leases.get(leaseKey(browserId, tabId));
        if (owner !== undefined && owner !== sessionId) return errorResponse(req.id, ErrorCode.LEASE_DENIED, `tab ${tabId} leased by another session`);
      }
      return null;
    }
    return null;
  }
  private applyLeaseSideEffects(sessionId: string, browserId: string, method: string, params: unknown): void {
    if (method === Method.ATTACH) {
      const { tabId } = (params ?? {}) as AttachParams;
      this.leases.set(leaseKey(browserId, tabId), sessionId);
    } else if (method === Method.DETACH) {
      const { tabId } = (params ?? {}) as DetachParams;
      if (this.leases.get(leaseKey(browserId, tabId)) === sessionId) this.leases.delete(leaseKey(browserId, tabId));
    }
  }
  private rollbackAttachLease(sessionId: string, browserId: string, method: string, params: unknown): void {
    if (method === Method.ATTACH) {
      const { tabId } = (params ?? {}) as AttachParams;
      if (this.leases.get(leaseKey(browserId, tabId)) === sessionId) this.leases.delete(leaseKey(browserId, tabId));
    }
  }

  /** Handle a message from a specific browser link. */
  handleBrowserMessage(browserId: string, msg: JsonRpcMessage): void {
    this.registry.touch(browserId);

    // Browser-originated request (id + method) — answer locally (R2: ping).
    if ('id' in msg && msg.id !== null && 'method' in msg) {
      const send = this.browsers.get(browserId);
      if (send) {
        const req = msg as JsonRpcRequest;
        if (req.method === Method.PING) send({ jsonrpc: '2.0', id: req.id, result: { pong: true } });
        else send({ jsonrpc: '2.0', id: req.id, error: { code: ErrorCode.METHOD_NOT_FOUND, message: `No broker handler for ${req.method}` } });
      }
      return;
    }

    // Browser response (id + result/error).
    if ('id' in msg && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const correlationId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const entry = this.pending.get(correlationId);
      if (entry === undefined) return;
      this.pending.delete(correlationId);
      clearTimeout(entry.timer);
      if ('result' in msg) {
        entry.resolve({ jsonrpc: '2.0', id: entry.originalId, result: (msg as JsonRpcSuccess).result });
      } else {
        this.rollbackAttachLease(entry.sessionId, entry.browserId, entry.method, entry.params);
        const err = (msg as JsonRpcErrorResponse).error;
        this.registry.recordError(browserId, err.message);
        entry.resolve({ jsonrpc: '2.0', id: entry.originalId, error: err });
      }
      return;
    }

    // Browser notification (method, no id) — buffer console + tag with browserId + broadcast.
    if ('method' in msg && !('id' in msg)) {
      if (msg.method === Notif.ON_CDP_EVENT) {
        const entry = toConsoleEntry(msg.params as OnCdpEventParams);
        if (entry) this.buffers.get(browserId)?.push(entry);
      }
      const params = (msg.params ?? {}) as Record<string, unknown>;
      this.broadcastToAgents({ jsonrpc: '2.0', method: msg.method, params: { ...params, browserId } });
    }
  }

  private broadcastToAgents(msg: JsonRpcMessage): void {
    for (const send of this.agents.values()) send(msg);
  }

  /** One browser link dropped: reject only its pending, clear its leases/buffer, notify. */
  onBrowserDisconnect(browserId: string): void {
    this.browsers.delete(browserId);
    this.buffers.delete(browserId);
    for (const [cid, entry] of this.pending) {
      if (entry.browserId === browserId) {
        clearTimeout(entry.timer);
        entry.resolve(errorResponse(entry.originalId, ErrorCode.EXTENSION_DISCONNECTED, 'browser extension disconnected'));
        this.pending.delete(cid);
      }
    }
    const prefix = `${browserId} `;
    for (const key of [...this.leases.keys()]) if (key.startsWith(prefix)) this.leases.delete(key);
    this.registry.disconnected(browserId);
    this.announceProfileChange(browserId);
  }

  onAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    for (const [key, owner] of this.leases) if (owner === sessionId) this.leases.delete(key);
    for (const [cid, entry] of this.pending) {
      if (entry.sessionId === sessionId) { clearTimeout(entry.timer); this.pending.delete(cid); }
    }
  }
}
```

- [ ] **Step 2: Rewrite `packages/broker/test/router.test.ts`** to the new API. A `Router` is now built with a `ProfileRegistry`, browsers register by id, and `handleBrowserMessage` takes a `browserId`. Use this complete suite (it preserves the old behaviors and adds multi-browser coverage):

```ts
import { describe, it, expect, vi } from 'vitest';
import { Router } from '../src/router.js';
import { ProfileRegistry } from '../src/profiles.js';
import { ErrorCode, Method, Notif, type JsonRpcMessage, type JsonRpcRequest } from '@claude-browser/shared';

function setup() {
  const registry = new ProfileRegistry();
  const router = new Router(registry);
  const browserSends: Record<string, JsonRpcMessage[]> = {};
  const agentSends: JsonRpcMessage[] = [];
  function connectBrowser(id: string, label = id) {
    browserSends[id] = [];
    registry.connected(id, label);
    router.registerBrowser(id, (m) => browserSends[id]!.push(m));
  }
  router.registerAgent('s1', (m) => agentSends.push(m));
  const lastFwd = (id: string) => browserSends[id]!.filter((m) => 'method' in m && 'id' in m).at(-1) as JsonRpcRequest;
  return { registry, router, browserSends, agentSends, connectBrowser, lastFwd };
}

describe('Router multi-browser routing', () => {
  it('auto-routes to the sole connected profile when browserId is omitted', async () => {
    const t = setup(); t.connectBrowser('a');
    const p = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 7, method: Method.GET_TABS, params: {} });
    const fwd = t.lastFwd('a');
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', id: fwd.id, result: { tabs: [] } });
    expect(await p).toEqual({ jsonrpc: '2.0', id: 7, result: { tabs: [] } });
  });

  it('returns AMBIGUOUS_PROFILE with the candidate list when >1 connected and none specified', async () => {
    const t = setup(); t.connectBrowser('a', 'A'); t.connectBrowser('b', 'B');
    const res = (await t.router.routeRequest('s1', { jsonrpc: '2.0', id: 1, method: Method.GET_TABS, params: {} })) as any;
    expect(res.error.code).toBe(ErrorCode.AMBIGUOUS_PROFILE);
    expect(res.error.data.profiles.map((p: any) => p.browserId).sort()).toEqual(['a', 'b']);
  });

  it('routes to the named profile when browserId is given', async () => {
    const t = setup(); t.connectBrowser('a'); t.connectBrowser('b');
    const p = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 2, method: Method.GET_TABS, params: { browserId: 'b' } });
    expect(t.browserSends['a']!.length).toBe(0);
    const fwd = t.lastFwd('b');
    t.router.handleBrowserMessage('b', { jsonrpc: '2.0', id: fwd.id, result: { tabs: [] } });
    await p;
    expect(t.browserSends['b']!.length).toBe(1);
  });

  it('serves listProfiles locally', async () => {
    const t = setup(); t.connectBrowser('a', 'A');
    const res = (await t.router.routeRequest('s1', { jsonrpc: '2.0', id: 3, method: Method.LIST_PROFILES, params: {} })) as any;
    expect(res.result.profiles[0]).toMatchObject({ browserId: 'a', label: 'A', status: 'connected' });
  });

  it('answers a browser-originated ping with {pong:true}', () => {
    const t = setup(); t.connectBrowser('a');
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', id: 99, method: Method.PING });
    expect(t.browserSends['a']!.at(-1)).toEqual({ jsonrpc: '2.0', id: 99, result: { pong: true } });
  });

  it('isolates disconnect: only the dropped profile\'s pending rejects', async () => {
    const t = setup(); t.connectBrowser('a'); t.connectBrowser('b');
    const pa = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 10, method: Method.GET_TABS, params: { browserId: 'a' } });
    const pb = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 11, method: Method.GET_TABS, params: { browserId: 'b' } });
    t.router.onBrowserDisconnect('a');
    expect((await pa as any).error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);
    const fwdB = t.lastFwd('b');
    t.router.handleBrowserMessage('b', { jsonrpc: '2.0', id: fwdB.id, result: { tabs: [] } });
    expect((await pb as any).result).toEqual({ tabs: [] });
    // an onProfileChange was broadcast for 'a'
    expect(t.agentSends.some((m) => 'method' in m && m.method === Notif.ON_PROFILE_CHANGE)).toBe(true);
  });

  it('leases are per (browserId, tabId): same tabId on different profiles does not collide', async () => {
    const t = setup(); t.connectBrowser('a'); t.connectBrowser('b');
    const pa = t.router.routeRequest('s1', { jsonrpc: '2.0', id: 20, method: Method.ATTACH, params: { tabId: 1, browserId: 'a' } });
    const pb = t.router.routeRequest('s2DifferentSession', { jsonrpc: '2.0', id: 21, method: Method.ATTACH, params: { tabId: 1, browserId: 'b' } });
    // neither is LEASE_DENIED (different browsers)
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', id: t.lastFwd('a').id, result: {} });
    t.router.handleBrowserMessage('b', { jsonrpc: '2.0', id: t.lastFwd('b').id, result: {} });
    expect((await pa as any).result).toEqual({});
    expect((await pb as any).result).toEqual({});
  });

  it('tags browser notifications with browserId before broadcasting to agents', () => {
    const t = setup(); t.connectBrowser('a');
    t.router.handleBrowserMessage('a', { jsonrpc: '2.0', method: Notif.ON_CDP_EVENT, params: { source: { tabId: 1 }, method: 'Page.loadEventFired', params: {} } });
    const note = t.agentSends.find((m) => 'method' in m && m.method === Notif.ON_CDP_EVENT) as any;
    expect(note.params.browserId).toBe('a');
  });
});
```

- [ ] **Step 3: Run + iterate** — `npm test -w @claude-browser/broker -- router` until all pass. Then `npm run typecheck -w @claude-browser/broker` (server.ts will not yet compile — that's Task 4; you may run the broker build after Task 4).
- [ ] **Step 4: Commit** — `git add packages/broker && git commit -m "feat(broker): multi-browser Router keyed by browserId"`

---

### Task 4: `server.ts` — accept multiple profile connections

**Files:**
- Modify: `packages/broker/src/server.ts`
- Modify: `packages/broker/test/server.test.ts`

- [ ] **Step 1: Edit `packages/broker/src/server.ts`.**

(a) Imports — `server.ts` no longer needs `ConsoleBuffer` (per-profile buffers now live in the Router). Replace its old `buffer`/`router` imports with:
```ts
import { Router } from './router.js';
import { ProfileRegistry } from './profiles.js';
```
(b) `ServerDeps` — drop the single `buffer` (buffers are per-profile in the Router now) and allow injecting a registry for tests:
```ts
export interface ServerDeps {
  router?: Router;
  registry?: ProfileRegistry;
  heartbeatMs?: number;
}
```
(c) `LiveSocket` — track the profile id:
```ts
interface LiveSocket extends WebSocket {
  isAlive: boolean;
  role?: 'browser' | 'agent';
  sessionId?: string;
  browserId?: string;
}
```
(d) In `startServer`, build the registry + router and a `browsers` map; **delete the old `const buffer = deps.buffer ?? new ConsoleBuffer();` line** and replace the `browserSocket`/`browserConnectedCallbacks` block:
```ts
  const registry = deps.registry ?? new ProfileRegistry();
  const router = deps.router ?? new Router(registry);
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  // ...wss unchanged...
  const browsers = new Map<string, LiveSocket>();
  const browserConnectedCallbacks = new Set<() => void>();
```
(e) Replace the `if (hello.role === 'browser')` branch with multi-profile handling (reads `instanceId`/`label`, replaces a same-id socket, registers in router + registry):
```ts
      if (hello.role === 'browser') {
        if (!browserOrigin || hello.extensionId !== config.extensionId || typeof hello.instanceId !== 'string') {
          ws.close(4001, 'UNAUTHORIZED');
          return;
        }
        const browserId = hello.instanceId;
        ws.role = 'browser';
        ws.browserId = browserId;
        // Replace a stale socket for the same profile.
        const prev = browsers.get(browserId);
        if (prev && prev !== ws) prev.terminate();
        browsers.set(browserId, ws);
        registry.connected(browserId, hello.label);
        attachBrowser(ws, browserId, router, () => {
          if (browsers.get(browserId) === ws) browsers.delete(browserId);
        });
        router.announceProfileChange(browserId);
        for (const cb of browserConnectedCallbacks) cb();
        return;
      }
```
(f) `BrokerServer` hook impls — make them "any browser" / "all browsers":
```ts
        hasBrowserConnection(): boolean {
          for (const ws of browsers.values()) if (ws.readyState === WebSocket.OPEN) return true;
          return false;
        },
        onBrowserConnected(cb: () => void): void { browserConnectedCallbacks.add(cb); },
        offBrowserConnected(cb: () => void): void { browserConnectedCallbacks.delete(cb); },
        dropBrowserConnection(): void {
          for (const ws of browsers.values()) ws.terminate();
          browsers.clear();
        },
```
(g) `attachBrowser` — take `browserId` and pass it to the router:
```ts
function attachBrowser(ws: LiveSocket, browserId: string, router: Router, onClose: () => void): void {
  router.registerBrowser(browserId, (msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(data.toString()) as JsonRpcMessage; } catch { return; }
    router.handleBrowserMessage(browserId, msg);
  });
  ws.on('close', () => {
    onClose();
    router.onBrowserDisconnect(browserId);
  });
}
```
`attachAgent` is unchanged. (Note: the `BrokerServer` interface keeps `hasBrowserConnection`/`onBrowserConnected`/`offBrowserConnected`/`dropBrowserConnection` exactly as declared in Task 4 of the base build — the integration harness depends on them.)

- [ ] **Step 2: Update `packages/broker/test/server.test.ts`** — every browser `hello` must now include `instanceId` and `label`. Find each browser hello (e.g. `{ type:'hello', role:'browser', extensionId }`) and add `instanceId: 'test-profile', label: 'Test'` (use distinct ids where a test connects two browsers). If a test injected `deps.buffer`, drop it (buffers are per-profile now); assert console behavior through `routeRequest(GET_CONSOLE)` against a connected browser instead. Add one new test:
```ts
it('tracks two profiles independently', async () => {
  const server = await startServer({ port: 0, token: 'tok', extensionId: 'ext' });
  // connect two browser sockets with distinct instanceIds (helper from existing tests),
  // send hellos with instanceId 'p1'/'p2', then:
  expect(server.hasBrowserConnection()).toBe(true);
  expect(server.router.connectedBrowserIds().sort()).toEqual(['p1', 'p2']);
  await server.close();
});
```
(Reuse the test's existing ws-client helper for the connect+hello handshake; if none exists, open two `ws` clients to `ws://127.0.0.1:${server.port}` with `Origin: chrome-extension://ext` and send the browser hellos.)

- [ ] **Step 3: Run broker suite + build, expect PASS** — `npm test -w @claude-browser/broker && npm run build -w @claude-browser/broker`.
- [ ] **Step 4: Commit** — `git add packages/broker && git commit -m "feat(broker): accept multiple profile connections keyed by instanceId"`

---

# Milestone C — Extension

### Task 5: Extension carries `instanceId` + `label`

**Files:**
- Modify: `packages/extension/src/background/config.ts`
- Modify: `packages/extension/src/background/transport.ts`
- Modify: `packages/extension/src/background/index.ts`
- Test: `packages/extension/test/config.test.ts` (create if absent)

- [ ] **Step 1: Failing test** `packages/extension/test/config.test.ts` (uses the existing chrome mock from `test/chromeMock.ts`):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './chromeMock.js';
import { getInstanceId, getLabel, INSTANCE_ID_KEY, LABEL_KEY } from '../src/background/config.js';

describe('extension profile identity', () => {
  beforeEach(() => installChromeMock());

  it('generates an instanceId once and returns it stably', async () => {
    const id1 = await getInstanceId();
    const id2 = await getInstanceId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThan(8);
  });

  it('defaults the label to "Profile <first4 of id>" and honors a stored label', async () => {
    const id = await getInstanceId();
    expect(await getLabel(id)).toBe(`Profile ${id.slice(0, 4)}`);
    await chrome.storage.local.set({ [LABEL_KEY]: 'Work' });
    expect(await getLabel(id)).toBe('Work');
  });
});
```

If `test/chromeMock.ts` does not expose a `crypto.randomUUID`, ensure the mock leaves the global `crypto` intact (Node's `globalThis.crypto.randomUUID` exists in Node ≥ 20). Confirm `installChromeMock()` does not delete `globalThis.crypto`.

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/extension -- config`.

- [ ] **Step 3: Add to `packages/extension/src/background/config.ts`:**

```ts
export const INSTANCE_ID_KEY = 'claudeBrowserInstanceId';
export const LABEL_KEY = 'claudeBrowserLabel';

/** Read-or-generate the stable per-install profile id (the agent-facing browserId). */
export async function getInstanceId(): Promise<string> {
  const got = await chrome.storage.local.get(INSTANCE_ID_KEY);
  const v = (got as Record<string, unknown>)[INSTANCE_ID_KEY];
  if (typeof v === 'string' && v.length > 0) return v;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_ID_KEY]: id });
  return id;
}

/** User-editable display label; defaults to `Profile <first4 of instanceId>`. */
export async function getLabel(instanceId: string): Promise<string> {
  const got = await chrome.storage.local.get(LABEL_KEY);
  const v = (got as Record<string, unknown>)[LABEL_KEY];
  if (typeof v === 'string' && v.length > 0) return v;
  return `Profile ${instanceId.slice(0, 4)}`;
}
```

- [ ] **Step 4: Thread into the hello.** In `packages/extension/src/background/transport.ts`, extend options + hello:
```ts
export interface TransportOptions { port: number; extensionId: string; instanceId: string; label: string; }
```
and in `connect()`'s `ws.onopen`, build the hello with the new fields:
```ts
      const hello: BrowserHello = { type: 'hello', role: 'browser', extensionId: this.opts.extensionId, instanceId: this.opts.instanceId, label: this.opts.label };
```

In `packages/extension/src/background/index.ts` `main()`, resolve and pass them:
```ts
import { resolvePort, resolveExtensionId, getInstanceId, getLabel } from './config';
// ...
async function main(): Promise<void> {
  const port = await resolvePort();
  const extensionId = resolveExtensionId();
  const instanceId = await getInstanceId();
  const label = await getLabel(instanceId);
  const transport = new Transport({ port, extensionId, instanceId, label });
  bootstrap(transport);
}
```

- [ ] **Step 5: Run extension tests + typecheck, expect PASS** — `npm test -w @claude-browser/extension && npm run typecheck -w @claude-browser/extension`. (If an existing transport test constructs `new Transport({port, extensionId})`, add `instanceId: 'test', label: 'Test'` to it.)
- [ ] **Step 6: Commit** — `git add packages/extension && git commit -m "feat(extension): per-install instanceId + label in BrowserHello"`

---

### Task 6: Popup — name this profile

**Files:**
- Modify: `packages/extension/src/popup/popup.ts`
- Modify: `packages/extension/src/popup/popup.html`
- Test: `packages/extension/test/popup.test.ts`

- [ ] **Step 1: Failing test** — add to `packages/extension/test/popup.test.ts` a case asserting a pure helper that reads/writes the label. Add this helper-targeting test:
```ts
import { applyLabelInput } from '../src/popup/popup.js';
it('writes the label input value to storage under LABEL_KEY', async () => {
  installChromeMock();
  await applyLabelInput('Personal');
  const got = await chrome.storage.local.get('claudeBrowserLabel');
  expect(got.claudeBrowserLabel).toBe('Personal');
});
```
(Match the existing popup test's import style; reuse `installChromeMock`.)

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/extension -- popup`.

- [ ] **Step 3: Implement.** In `packages/extension/src/popup/popup.ts` add the pure helper and wire it in the DOM bootstrap (keep the existing status-dot logic):
```ts
import { LABEL_KEY } from '../background/config.js';

/** Pure: persist a profile label (trimmed; empty clears to default on next read). */
export async function applyLabelInput(value: string): Promise<void> {
  await chrome.storage.local.set({ [LABEL_KEY]: value.trim() });
}

// In the existing DOMContentLoaded bootstrap, after rendering status:
const labelInput = document.getElementById('cb-label') as HTMLInputElement | null;
if (labelInput) {
  const got = await chrome.storage.local.get(LABEL_KEY);
  labelInput.value = typeof got[LABEL_KEY] === 'string' ? (got[LABEL_KEY] as string) : '';
  labelInput.addEventListener('change', () => { void applyLabelInput(labelInput.value); });
}
```
In `packages/extension/src/popup/popup.html`, add the input (no inline script — MV3 CSP):
```html
<label style="display:block;margin-top:8px;font:12px system-ui">此 Profile 名称
  <input id="cb-label" type="text" placeholder="例如 工作 / 个人" style="width:100%;box-sizing:border-box" />
</label>
```

- [ ] **Step 4: Run + build, expect PASS** — `npm test -w @claude-browser/extension && npm run build -w @claude-browser/extension`.
- [ ] **Step 5: Commit** — `git add packages/extension && git commit -m "feat(extension): popup profile-name input"`

---

# Milestone D — MCP server

### Task 7: Tool context — selected profile + browserId injection

**Files:**
- Modify: `packages/mcp-server/src/context.ts`
- Test: `packages/mcp-server/test/context.test.ts`

- [ ] **Step 1: Failing test** — add to `packages/mcp-server/test/context.test.ts`:
```ts
import { createContext, profileParam } from '../src/context.js';
it('profileParam prefers explicit, then selected, else empty', () => {
  const ctx = createContext({ request: async () => ({}) });
  expect(profileParam(ctx)).toEqual({});
  ctx.selectedBrowserId = 'sel';
  expect(profileParam(ctx)).toEqual({ browserId: 'sel' });
  expect(profileParam(ctx, 'explicit')).toEqual({ browserId: 'explicit' });
});
it('attach forwards the resolved browserId', async () => {
  const calls: any[] = [];
  const ctx = createContext({ request: async (m, p) => { calls.push([m, p]); return {}; } });
  ctx.selectedBrowserId = 'b1';
  await ctx.attach(5);
  expect(calls[0][1]).toEqual({ tabId: 5, browserId: 'b1' });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/mcp-server -- context`.

- [ ] **Step 3: Edit `packages/mcp-server/src/context.ts`:**
```ts
export interface ToolContext {
  client: RpcLike;
  refs: Map<string, number>;
  attach(tabId: number, browserId?: string): Promise<void>;
  /** Remembered profile for this session; set by browser_select_profile. */
  selectedBrowserId: string | null;
}

export function createContext(client: RpcLike): ToolContext {
  const refs = new Map<string, number>();
  const ctx: ToolContext = {
    client,
    refs,
    selectedBrowserId: null,
    async attach(tabId: number, browserId?: string): Promise<void> {
      const bid = browserId ?? ctx.selectedBrowserId ?? undefined;
      const params: AttachParams = bid ? { tabId, browserId: bid } : { tabId };
      await client.request(Method.ATTACH, params);
    },
  };
  return ctx;
}

/** Resolve the browserId param for a request: explicit → selected → none. */
export function profileParam(ctx: ToolContext, explicit?: string): { browserId?: string } {
  const bid = explicit ?? ctx.selectedBrowserId ?? undefined;
  return bid ? { browserId: bid } : {};
}
```

- [ ] **Step 4: Run, expect PASS** — `npm test -w @claude-browser/mcp-server -- context`.
- [ ] **Step 5: Commit** — `git add packages/mcp-server && git commit -m "feat(mcp): tool context selected-profile + profileParam helper"`

---

### Task 8: Profile tools — list / select / status / logs

**Files:**
- Create: `packages/mcp-server/src/tools/profiles.ts`
- Modify: `packages/mcp-server/src/tools/index.ts` (register them)
- Test: `packages/mcp-server/test/tools.profiles.test.ts`

- [ ] **Step 1: Failing test** `packages/mcp-server/test/tools.profiles.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { profileTools } from '../src/tools/profiles.js';
import { createContext } from '../src/context.js';
import { Method } from '@claude-browser/shared';

function fakeClient(responses: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = [];
  return { calls, request: async (m: string, p?: unknown) => { calls.push([m, p]); return responses[m]; } };
}
const byName = (n: string) => profileTools.find((t) => t.name === n)!;

describe('profile tools', () => {
  it('browser_list_profiles renders connected profiles', async () => {
    const client = fakeClient({ [Method.LIST_PROFILES]: { profiles: [{ browserId: 'a', label: 'Work', status: 'connected', reconnectCount: 0, tabCount: 2 }] } });
    const ctx = createContext(client);
    const res = await byName('browser_list_profiles').handler({}, ctx);
    expect(JSON.stringify(res.content)).toContain('Work');
    expect(JSON.stringify(res.content)).toContain('a');
  });

  it('browser_select_profile resolves by label and remembers it', async () => {
    const client = fakeClient({ [Method.LIST_PROFILES]: { profiles: [{ browserId: 'id-1', label: 'Work', status: 'connected', reconnectCount: 0, tabCount: 0 }] } });
    const ctx = createContext(client);
    await byName('browser_select_profile').handler({ label: 'Work' }, ctx);
    expect(ctx.selectedBrowserId).toBe('id-1');
  });

  it('browser_status calls GET_PROFILE_STATUS', async () => {
    const client = fakeClient({ [Method.GET_PROFILE_STATUS]: { profiles: [] } });
    const ctx = createContext(client);
    await byName('browser_status').handler({}, ctx);
    expect(client.calls[0][0]).toBe(Method.GET_PROFILE_STATUS);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/mcp-server -- tools.profiles`.

- [ ] **Step 3: Create `packages/mcp-server/src/tools/profiles.ts`:**
```ts
import { z } from 'zod';
import {
  Method,
  type ListProfilesResult,
  type ProfileInfo,
  type GetProfileLogsResult,
} from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';

function fmt(p: ProfileInfo): string {
  const err = p.lastError ? ` lastError="${p.lastError.message}"` : '';
  return `${p.browserId}  [${p.label}]  ${p.status}  tabs=${p.tabCount} reconnects=${p.reconnectCount}${err}`;
}

const browser_list_profiles = defineTool({
  name: 'browser_list_profiles',
  description: 'List all connected browser profiles with status. When more than one is connected and none is selected, ask the user which to use (via a native choice) then call browser_select_profile.',
  inputSchema: {},
  async handler(_args, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<ListProfilesResult>(Method.LIST_PROFILES, {});
    if (res.profiles.length === 0) return textResult('(no browser profiles connected)');
    return textResult(res.profiles.map(fmt).join('\n'));
  },
});

const browser_select_profile = defineTool({
  name: 'browser_select_profile',
  description: 'Select which connected profile this session drives, by browserId or label. Remembered for the rest of the session.',
  inputSchema: { browserId: z.string().optional(), label: z.string().optional() },
  async handler({ browserId, label }, ctx): Promise<ToolResult> {
    let resolved = browserId;
    if (!resolved && label) {
      const res = await ctx.client.request<ListProfilesResult>(Method.LIST_PROFILES, {});
      resolved = res.profiles.find((p) => p.label === label)?.browserId;
    }
    if (!resolved) return { ...textResult(`no profile matched ${browserId ?? label ?? '(nothing)'}`), isError: true };
    ctx.selectedBrowserId = resolved;
    return textResult(`selected profile ${resolved}`);
  },
});

const browser_status = defineTool({
  name: 'browser_status',
  description: 'Show connection status (connected/disconnected/reconnecting), last error, reconnect count and tab count for a profile, or all profiles when none is given.',
  inputSchema: { browserId: z.string().optional() },
  async handler({ browserId }, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<{ profiles: ProfileInfo[] } | ProfileInfo | null>(
      Method.GET_PROFILE_STATUS,
      browserId ? { browserId } : {},
    );
    if (res === null) return textResult('(unknown profile)');
    const profiles = 'profiles' in res ? res.profiles : [res];
    return textResult(profiles.map(fmt).join('\n') || '(none)');
  },
});

const browser_logs = defineTool({
  name: 'browser_logs',
  description: 'Recent connect/disconnect/error/reconnect events for a profile (defaults to the selected profile).',
  inputSchema: { browserId: z.string().optional(), limit: z.number().int().positive().optional() },
  async handler({ browserId, limit }, ctx): Promise<ToolResult> {
    const bid = browserId ?? ctx.selectedBrowserId ?? undefined;
    const res = await ctx.client.request<GetProfileLogsResult>(
      Method.GET_PROFILE_LOGS,
      { ...(bid ? { browserId: bid } : {}), ...(limit ? { limit } : {}) },
    );
    if (res.events.length === 0) return textResult('(no events)');
    return textResult(res.events.map((e) => `${new Date(e.at).toISOString()}  ${e.kind}${e.detail ? '  ' + e.detail : ''}`).join('\n'));
  },
});

export const profileTools: ToolDef[] = [
  browser_list_profiles, browser_select_profile, browser_status, browser_logs,
] as unknown as ToolDef[];
```

- [ ] **Step 4: Register them.** In `packages/mcp-server/src/tools/index.ts`, import `profileTools` and include them in the array passed to `registerAll` (follow the existing aggregation pattern, e.g. `[...visionTools, ...domTools, ...navigationTools, ...tabsTools, ...consoleTools, ...profileTools]`).
- [ ] **Step 5: Run + typecheck, expect PASS** — `npm test -w @claude-browser/mcp-server -- tools.profiles && npm run typecheck -w @claude-browser/mcp-server`.
- [ ] **Step 6: Commit** — `git add packages/mcp-server && git commit -m "feat(mcp): browser_list_profiles/select_profile/status/logs tools"`

---

### Task 9: Existing tools take an optional `profile`; AMBIGUOUS guidance

**Files:**
- Modify: `packages/mcp-server/src/tools/types.ts` (execCdp gains browserId)
- Modify: `packages/mcp-server/src/tools/{vision,dom,navigation,tabs,console}.ts`
- Modify: `packages/mcp-server/src/tools/index.ts` (AMBIGUOUS_PROFILE → guidance)
- Test: `packages/mcp-server/test/tools.profile-routing.test.ts`

- [ ] **Step 1: Failing test** `packages/mcp-server/test/tools.profile-routing.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { tabsTools } from '../src/tools/tabs.js';
import { createContext } from '../src/context.js';
import { Method, ErrorCode } from '@claude-browser/shared';
import { RpcError } from '../src/client.js';
import { registerAll } from '../src/tools/index.js';

const getTabs = () => tabsTools.find((t) => t.name === 'browser_get_tabs')!;

describe('profile routing in existing tools', () => {
  it('injects selectedBrowserId into the request params', async () => {
    const calls: any[] = [];
    const ctx = createContext({ request: async (m: string, p?: unknown) => { calls.push([m, p]); return { tabs: [] }; } });
    ctx.selectedBrowserId = 'b9';
    await getTabs().handler({}, ctx);
    expect(calls[0][0]).toBe(Method.GET_TABS);
    expect(calls[0][1]).toMatchObject({ browserId: 'b9' });
  });

  it('explicit profile arg overrides the selection', async () => {
    const calls: any[] = [];
    const ctx = createContext({ request: async (_m: string, p?: unknown) => { calls.push(p); return { tabs: [] }; } });
    ctx.selectedBrowserId = 'b9';
    await getTabs().handler({ profile: 'other' }, ctx);
    expect(calls[0]).toMatchObject({ browserId: 'other' });
  });

  it('registerAll converts AMBIGUOUS_PROFILE into a non-fatal guidance result', async () => {
    const tools = new Map<string, (a: any, c: any) => Promise<any>>();
    const sink = { registerTool(name: string, _cfg: unknown, h: (a: any, c: any) => Promise<any>) { tools.set(name, h); } };
    const ctx = createContext({
      request: async () => { throw new RpcError(ErrorCode.AMBIGUOUS_PROFILE, 'ambiguous', { profiles: [{ browserId: 'a', label: 'A', status: 'connected', reconnectCount: 0, tabCount: 0 }] }); },
    });
    registerAll(sink as any, ctx);
    const res = await tools.get('browser_get_tabs')!({}, ctx);
    expect(JSON.stringify(res.content)).toContain('browser_select_profile');
    expect(res.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/mcp-server -- profile-routing`.

- [ ] **Step 3a: `execCdp` gains browserId.** In `packages/mcp-server/src/tools/types.ts` replace `execCdp`/`execCdpSeq` with:
```ts
export function execCdp<R = unknown>(
  ctx: ToolContext, tabId: number, cmd: CdpCommand,
  opts?: { browserId?: string; timeoutMs?: number },
): Promise<R> {
  const bid = opts?.browserId ?? ctx.selectedBrowserId ?? undefined;
  const params: ExecuteCdpParams = {
    target: { tabId }, method: cmd.method, params: cmd.params, timeoutMs: opts?.timeoutMs,
    ...(bid ? { browserId: bid } : {}),
  };
  return ctx.client.request<R>(Method.EXECUTE_CDP, params, opts?.timeoutMs);
}
export async function execCdpSeq(
  ctx: ToolContext, tabId: number, cmds: CdpCommand[], opts?: { browserId?: string },
): Promise<void> {
  for (const cmd of cmds) await execCdp(ctx, tabId, cmd, opts);
}
```
> **Call-site migration:** `execCdp`'s 4th argument changed from `timeoutMs?: number` to an options object. Grep `packages/mcp-server/src/tools` for any existing `execCdp(ctx, tabId, cmd, <number>)` calls and rewrite them as `execCdp(ctx, tabId, cmd, { timeoutMs: <number> })` (and add `browserId` per 3b). Calls with only three args are unaffected.

- [ ] **Step 3b: Add `profile` to each existing tool and inject it.** For every tool in `vision.ts`, `dom.ts`, `navigation.ts`, `tabs.ts`, `console.ts`:
  - add `profile: z.string().optional()` to its `inputSchema`;
  - merge `...profileParam(ctx, args.profile)` into the request `params` for broker-helper calls, and pass `{ browserId: args.profile ?? ctx.selectedBrowserId ?? undefined }` to `execCdp`/`ctx.attach`.

  Worked example — `tabs.ts` `browser_get_tabs` (apply the same shape to all others):
```ts
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';
import { profileParam } from '../context.js';
// ...
const browser_get_tabs = defineTool({
  name: 'browser_get_tabs',
  description: 'List open browser tabs (id, url, title, active). Optionally target a specific profile.',
  inputSchema: { profile: z.string().optional() },
  async handler({ profile }, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<GetTabsResult>(Method.GET_TABS, { ...profileParam(ctx, profile) });
    const lines = res.tabs.map((t) => `${t.id}${t.active ? ' *' : ''}: ${t.title ?? '(untitled)'} — ${t.url ?? ''}`);
    return textResult(lines.join('\n') || '(no tabs)');
  },
});
```
  For CDP-driven tools (vision/dom/navigation), compute `const browserId = profile ?? ctx.selectedBrowserId ?? undefined;` once, pass `{ browserId }` to `ctx.attach(tabId, browserId)` and to `execCdp(ctx, tabId, cmd, { browserId })`.

- [ ] **Step 3c: AMBIGUOUS guidance in `registerAll`.** In `packages/mcp-server/src/tools/index.ts`, wrap each handler so an `AMBIGUOUS_PROFILE` RpcError becomes a guidance result instead of a thrown error:
```ts
import { ErrorCode, type AmbiguousProfileData } from '@claude-browser/shared';
import { RpcError } from '../client.js';
import { textResult } from './types.js';

function ambiguousGuidance(data: AmbiguousProfileData) {
  const list = data.profiles.map((p) => `- ${p.browserId} [${p.label}] ${p.status}`).join('\n');
  return textResult(
    `Multiple browser profiles are connected and none is selected:\n${list}\n` +
    `Ask the user which profile to use (present these as a native choice), then call ` +
    `browser_select_profile with the chosen browserId, then retry.`,
  );
}

// inside registerAll, when registering each ToolDef `def`:
server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, async (args: unknown) => {
  try {
    return await def.handler(args as never, ctx);
  } catch (e) {
    if (e instanceof RpcError && e.code === ErrorCode.AMBIGUOUS_PROFILE) {
      return ambiguousGuidance(e.data as AmbiguousProfileData);
    }
    throw e;
  }
});
```
(Adapt to the existing `registerAll` signature/loop; keep `browser_list_profiles`/`browser_select_profile` registered too — they never throw AMBIGUOUS.)

- [ ] **Step 4: Run full mcp suite + typecheck + build, expect PASS** — `npm test -w @claude-browser/mcp-server && npm run typecheck -w @claude-browser/mcp-server && npm run build -w @claude-browser/mcp-server`.
- [ ] **Step 5: Commit** — `git add packages/mcp-server && git commit -m "feat(mcp): per-call profile arg + AMBIGUOUS_PROFILE guidance"`

---

# Milestone E — Integration

### Task 10: Two-profile integration test (env-gated)

**Files:**
- Modify: `test/integration/harness.ts` (support launching N profiles)
- Create: `test/integration/multi-profile.test.ts`

- [ ] **Step 1: Extend the harness** to launch two Chrome instances with **distinct `--user-data-dir`s** (each gets its own extension install → distinct `instanceId`), all pointing at the one broker on `DEFAULT_PORT`. Add an exported `startTwoProfileHarness()` returning `{ broker, client, callTool, listProfiles(), teardown() }`, reusing the existing single-profile `startHarness` building blocks (broker via `startServer`, agent via `createClient`/`registerTools`). Wait until `broker.router.connectedBrowserIds().length === 2` (poll up to 20s).

- [ ] **Step 2: Write `test/integration/multi-profile.test.ts`:**
```ts
import { describe, it, expect, afterAll } from 'vitest';
import { shouldRunBrowserTests, startTwoProfileHarness } from './harness.js';

const d = shouldRunBrowserTests() ? describe : describe.skip;
d('multi-profile e2e', () => {
  let h: Awaited<ReturnType<typeof startTwoProfileHarness>>;
  afterAll(async () => { await h?.teardown(); });

  it('lists two profiles, then drives a chosen one', async () => {
    h = await startTwoProfileHarness();
    const profiles = await h.listProfiles();
    expect(profiles.length).toBe(2);
    // selecting one and creating a tab there succeeds without AMBIGUOUS
    const sel = await h.callTool('browser_select_profile', { browserId: profiles[0].browserId });
    expect(sel.isError).toBeFalsy();
    const res = await h.callTool('browser_new_tab', {});
    expect(JSON.stringify(res.content)).toMatch(/opened tab/);
  });
});
```

- [ ] **Step 3: Run gated** — `RUN_BROWSER_TESTS=1 npx vitest run --config vitest.integration.config.ts test/integration/multi-profile.test.ts`. (Subject to the same Chrome `--load-extension` limitation documented in the base spec — the test is `describe.skip` without the env flag, so the default hermetic suite is unaffected.)
- [ ] **Step 4: Run the full hermetic suite to confirm nothing regressed** — `npm test` (expect all unit tests green) + `npm run build` + `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add test && git commit -m "test(integration): two-profile e2e (env-gated)"`

---

## Definition of done
- `npm test` (hermetic) green across shared/broker/extension/mcp-server + scripts/lib; `npm run typecheck` and `npm run build` clean.
- Broker tracks ≥2 profiles, routes by `browserId`, returns `AMBIGUOUS_PROFILE` (with the profile list) when ambiguous, and isolates per-profile disconnects.
- Extension sends a stable `instanceId` + editable `label`; popup can rename the profile.
- MCP exposes `browser_list_profiles`/`browser_select_profile`/`browser_status`/`browser_logs`; existing tools accept `profile`; ambiguity yields native-picker guidance; selection is remembered per session.
