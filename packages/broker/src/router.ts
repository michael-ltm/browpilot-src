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
  type SubscribeEventsParams,
  type SubscribeEventsResult,
  type GetEventsParams,
  type GetEventsResult,
  type CdpEvent,
} from '@browpilot/shared';
import { ConsoleBuffer } from './buffer.js';
import { EventBuffer } from './event-buffer.js';
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
  return `${browserId} ${tabId}`;
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
  /** Per-profile buffer of subscribed CDP events (Network/Debugger/Target/...). */
  private readonly eventBuffers = new Map<string, EventBuffer>();
  /** Per-profile set of subscribed CDP event method prefixes (e.g. 'Network.'). */
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly agents = new Map<string, Send>();
  private readonly pending = new Map<number, Pending>();
  /** leaseKey(browserId, tabId) -> owning sessionId */
  private readonly leases = new Map<string, string>();
  private nextCorrelationId = 1;

  constructor(private readonly registry: ProfileRegistry) {}

  registerBrowser(browserId: string, send: Send): void {
    this.browsers.set(browserId, send);
    if (!this.buffers.has(browserId)) this.buffers.set(browserId, new ConsoleBuffer());
    if (!this.eventBuffers.has(browserId)) this.eventBuffers.set(browserId, new EventBuffer());
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

    // Broker-local: set which CDP event method prefixes to buffer for this profile.
    if (req.method === Method.SUBSCRIBE_EVENTS) {
      const params = (req.params ?? {}) as SubscribeEventsParams;
      // Union by default so enabling one capture (Network.) doesn't drop another
      // (Debugger.); pass replace:true to reset the set.
      const set = params.replace ? new Set<string>() : (this.subscriptions.get(browserId) ?? new Set<string>());
      for (const p of params.prefixes ?? []) set.add(p);
      this.subscriptions.set(browserId, set);
      const result: SubscribeEventsResult = { prefixes: [...set] };
      return Promise.resolve({ jsonrpc: '2.0', id: req.id, result });
    }
    // Broker-local: read (and optionally clear) buffered CDP events.
    if (req.method === Method.GET_EVENTS) {
      const params = (req.params ?? {}) as GetEventsParams;
      const buf = this.eventBuffers.get(browserId);
      const result: GetEventsResult = { events: buf ? buf.query(params) : [] };
      if (params.clear) buf?.clear();
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
    if (explicit !== undefined) {
      // Exact browserId match — the common case.
      if (this.browsers.has(explicit)) return { browserId: explicit };
      // Otherwise accept a profile LABEL (browser_select_profile takes a label, so a
      // per-call `profile`/browserId should too). Resolve label -> connected browserId.
      const byLabel = this.registry.connectedByLabel(explicit).filter((id) => this.browsers.has(id));
      if (byLabel.length === 1) return { browserId: byLabel[0]! };
      if (byLabel.length > 1) {
        return { error: errorResponse(reqId, ErrorCode.AMBIGUOUS_PROFILE, `multiple connected profiles labeled "${explicit}"; pass a browserId`, { profiles: this.registry.list() }) };
      }
      // Unknown id/label: fall through so the caller surfaces the clear "not connected" error.
      return { browserId: explicit };
    }
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
    this.syncTabCount(browserId);
  }
  private rollbackAttachLease(sessionId: string, browserId: string, method: string, params: unknown): void {
    if (method === Method.ATTACH) {
      const { tabId } = (params ?? {}) as AttachParams;
      if (this.leases.get(leaseKey(browserId, tabId)) === sessionId) this.leases.delete(leaseKey(browserId, tabId));
    }
    this.syncTabCount(browserId);
  }

  /** Recompute a profile's tabCount from its active leases and publish it to the registry. */
  private syncTabCount(browserId: string): void {
    const prefix = `${browserId} `;
    let n = 0;
    for (const key of this.leases.keys()) if (key.startsWith(prefix)) n++;
    this.registry.setTabCount(browserId, n);
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
        const cdp = msg.params as OnCdpEventParams;
        const entry = toConsoleEntry(cdp);
        if (entry) this.buffers.get(browserId)?.push(entry);
        const subs = this.subscriptions.get(browserId);
        if (subs && subs.size > 0 && [...subs].some((p) => cdp.method.startsWith(p))) {
          const ev: CdpEvent = { tabId: cdp.source?.tabId, method: cdp.method, params: cdp.params, timestamp: Date.now() };
          this.eventBuffers.get(browserId)?.push(ev);
        }
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
    this.eventBuffers.delete(browserId);
    this.subscriptions.delete(browserId);
    for (const [cid, entry] of this.pending) {
      if (entry.browserId === browserId) {
        clearTimeout(entry.timer);
        entry.resolve(errorResponse(entry.originalId, ErrorCode.EXTENSION_DISCONNECTED, 'browser extension disconnected'));
        this.pending.delete(cid);
      }
    }
    const prefix = `${browserId} `;
    for (const key of [...this.leases.keys()]) if (key.startsWith(prefix)) this.leases.delete(key);
    this.syncTabCount(browserId);
    this.registry.disconnected(browserId);
    this.announceProfileChange(browserId);
  }

  onAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    for (const [key, owner] of this.leases) if (owner === sessionId) this.leases.delete(key);
    for (const bid of this.browsers.keys()) this.syncTabCount(bid);
    for (const [cid, entry] of this.pending) {
      if (entry.sessionId === sessionId) { clearTimeout(entry.timer); this.pending.delete(cid); }
    }
  }
}
