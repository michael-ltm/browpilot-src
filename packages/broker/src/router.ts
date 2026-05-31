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
  type OnCdpEventParams,
  type OnStatusParams,
  type ConsoleEntry,
} from '@claude-browser/shared';
import type { ConsoleBuffer } from './buffer.js';

type Send = (msg: JsonRpcMessage) => void;

/** Per-request timeout (ms). Fires ErrorCode.TIMEOUT if the browser never responds. */
const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  originalId: number | string;
  sessionId: string;
  /**
   * Resolves (never rejects) with the response message — error responses are
   * returned as JsonRpcErrorResponse values rather than thrown, which avoids
   * unhandled-rejection noise. (The spec draft names this field `reject`, but
   * always resolving is safer in practice.)
   */
  resolve: (msg: JsonRpcMessage) => void;
  /** Original method, retained for ATTACH lease rollback on browser error. */
  method: string;
  /** Original params, retained for ATTACH lease rollback on browser error. */
  params: unknown;
  /** Timer handle for per-request timeout. */
  timer: ReturnType<typeof setTimeout>;
}

function errorResponse(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** CDP console-event methods that produce ConsoleEntry rows in the buffer. */
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
    return {
      tabId,
      level: typeof raw.type === 'string' ? raw.type : 'log',
      text,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
      args: args as unknown[],
    };
  }
  // Log.entryAdded
  const entry = (raw.entry ?? {}) as Record<string, unknown>;
  return {
    tabId,
    level: typeof entry.level === 'string' ? entry.level : 'log',
    text: typeof entry.text === 'string' ? entry.text : '',
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    url: typeof entry.url === 'string' ? entry.url : undefined,
  };
}

/**
 * Transport-agnostic core: routes agent JSON-RPC to the single browser link,
 * owns the pending map / correlation ids, per-session tab leases, and the
 * console buffer ingest + local GET_CONSOLE service.
 *
 * R2: handleBrowserMessage also handles browser-originated requests (e.g. ping),
 * answering them locally so the extension heartbeat never silently fails.
 */
export class Router {
  private browserSend: Send | null = null;
  private readonly agents = new Map<string, Send>();
  private readonly pending = new Map<number, Pending>();
  /** tabId -> owning sessionId */
  private readonly leases = new Map<number, string>();
  private nextCorrelationId = 1;

  constructor(private readonly buffer: ConsoleBuffer) {}

  registerBrowser(send: Send): void {
    this.browserSend = send;
  }

  registerAgent(sessionId: string, send: Send): void {
    this.agents.set(sessionId, send);
  }

  hasBrowser(): boolean {
    return this.browserSend !== null;
  }

  /** Route one agent request; resolves with the message to send back to that agent. */
  routeRequest(sessionId: string, req: JsonRpcRequest): Promise<JsonRpcMessage> {
    // Locally served: console reads from the buffer.
    if (req.method === Method.GET_CONSOLE) {
      const params = (req.params ?? {}) as GetConsoleParams;
      const result: GetConsoleResult = { entries: this.buffer.query(params) };
      const ok: JsonRpcSuccess<GetConsoleResult> = { jsonrpc: '2.0', id: req.id, result };
      return Promise.resolve(ok);
    }

    // Lease enforcement.
    const leaseError = this.checkLease(sessionId, req);
    if (leaseError) return Promise.resolve(leaseError);

    if (this.browserSend === null) {
      return Promise.resolve(
        errorResponse(req.id, ErrorCode.EXTENSION_DISCONNECTED, 'browser extension not connected'),
      );
    }

    const correlationId = this.nextCorrelationId++;
    const forwarded: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: correlationId,
      method: req.method,
      params: req.params,
    };

    return new Promise<JsonRpcMessage>((resolve) => {
      // Apply lease side effects optimistically (before the browser ACK) so that
      // a concurrent ATTACH for the same tab from another session is blocked
      // immediately by checkLease — rather than both requests slipping through
      // before either ACK arrives and one silently overwriting the other's lease.
      // If the browser returns an error for ATTACH, the lease is rolled back in
      // handleBrowserMessage so no phantom lease is left behind.
      this.applyLeaseSideEffects(sessionId, req.method, req.params);

      const timer = setTimeout(() => {
        if (this.pending.delete(correlationId)) {
          // Also rollback an optimistic ATTACH lease that timed out.
          this.rollbackAttachLease(sessionId, req.method, req.params);
          resolve(errorResponse(req.id, ErrorCode.TIMEOUT, 'browser did not respond in time'));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(correlationId, {
        originalId: req.id,
        sessionId,
        resolve,
        method: req.method,
        params: req.params,
        timer,
      });
      this.browserSend!(forwarded);
    });
  }

  /** Returns a LEASE_DENIED error response if the request violates a lease, else null. */
  private checkLease(sessionId: string, req: JsonRpcRequest): JsonRpcErrorResponse | null {
    if (req.method === Method.ATTACH) {
      const { tabId } = (req.params ?? {}) as AttachParams;
      const owner = this.leases.get(tabId);
      if (owner !== undefined && owner !== sessionId) {
        return errorResponse(req.id, ErrorCode.LEASE_DENIED, `tab ${tabId} leased by another session`);
      }
      return null;
    }
    if (req.method === Method.EXECUTE_CDP) {
      const { target } = (req.params ?? {}) as ExecuteCdpParams;
      const tabId = target?.tabId;
      if (typeof tabId === 'number') {
        const owner = this.leases.get(tabId);
        if (owner !== undefined && owner !== sessionId) {
          return errorResponse(req.id, ErrorCode.LEASE_DENIED, `tab ${tabId} leased by another session`);
        }
      }
      return null;
    }
    return null;
  }

  private applyLeaseSideEffects(sessionId: string, method: string, params: unknown): void {
    if (method === Method.ATTACH) {
      const { tabId } = ((params ?? {}) as AttachParams);
      this.leases.set(tabId, sessionId);
    } else if (method === Method.DETACH) {
      const { tabId } = ((params ?? {}) as DetachParams);
      if (this.leases.get(tabId) === sessionId) this.leases.delete(tabId);
    }
  }

  /**
   * Rolls back an optimistically-applied ATTACH lease when the browser returns
   * an error (or when the request times out). Only ATTACH is rolled back; DETACH
   * is left as-is because releasing a lease on a tab the browser rejected is safe.
   */
  private rollbackAttachLease(sessionId: string, method: string, params: unknown): void {
    if (method === Method.ATTACH) {
      const { tabId } = ((params ?? {}) as AttachParams);
      // Only clear if we still own it — a re-attach by the same session would have
      // re-set the entry, so we must not accidentally clear a valid successor lease.
      if (this.leases.get(tabId) === sessionId) this.leases.delete(tabId);
    }
  }

  /**
   * Handle any message coming from the browser link.
   *
   * R2: Browser-originated REQUEST (has both id AND method): answer locally, do NOT route.
   * This is required for the extension heartbeat (ping) to work correctly.
   */
  handleBrowserMessage(msg: JsonRpcMessage): void {
    // R2: Browser-originated request (id + method) — answer locally.
    if ('id' in msg && msg.id !== null && 'method' in msg) {
      if (this.browserSend) {
        const req = msg as JsonRpcRequest;
        if (req.method === Method.PING) {
          this.browserSend({ jsonrpc: '2.0', id: req.id, result: { pong: true } });
        } else {
          this.browserSend({
            jsonrpc: '2.0',
            id: req.id,
            error: { code: ErrorCode.METHOD_NOT_FOUND, message: `No broker handler for ${req.method}` },
          });
        }
      }
      return;
    }

    // Browser response (id + result/error) → resolve the matching pending entry.
    if ('id' in msg && msg.id !== null && ('result' in msg || 'error' in msg)) {
      // The broker always issues integer correlation IDs (nextCorrelationId++), so
      // msg.id is expected to be a number. The Number() coercion handles the edge
      // case where a well-behaved browser echoes it back as a string (e.g. "1").
      const correlationId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const entry = this.pending.get(correlationId);
      if (entry === undefined) return;
      this.pending.delete(correlationId);
      clearTimeout(entry.timer);
      if ('result' in msg) {
        // Lease side effects were already applied optimistically at forward time.
        entry.resolve({ jsonrpc: '2.0', id: entry.originalId, result: (msg as JsonRpcSuccess).result });
      } else {
        // On error, roll back the optimistically-applied ATTACH lease so no
        // phantom lease is left behind (e.g. when the browser says tab not found).
        this.rollbackAttachLease(entry.sessionId, entry.method, entry.params);
        const err = (msg as JsonRpcErrorResponse).error;
        entry.resolve({ jsonrpc: '2.0', id: entry.originalId, error: err });
      }
      return;
    }

    // Notification from the browser (method, no id).
    if ('method' in msg && !('id' in msg)) {
      if (msg.method === Notif.ON_CDP_EVENT) {
        const entry = toConsoleEntry(msg.params as OnCdpEventParams);
        if (entry) this.buffer.push(entry);
      }
      this.broadcastToAgents(msg);
    }
  }

  private broadcastToAgents(msg: JsonRpcMessage): void {
    for (const send of this.agents.values()) send(msg);
  }

  /** Browser link dropped: reject every pending request and tell agents. */
  onBrowserDisconnect(): void {
    this.browserSend = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(
        errorResponse(entry.originalId, ErrorCode.EXTENSION_DISCONNECTED, 'browser extension disconnected'),
      );
    }
    this.pending.clear();
    const status: OnStatusParams = { state: 'disconnected', detail: 'extension link closed' };
    this.broadcastToAgents({ jsonrpc: '2.0', method: Notif.ON_STATUS, params: status });
  }

  /** Agent session ended: release its leases and drop its pending entries. */
  onAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    for (const [tabId, owner] of this.leases) {
      if (owner === sessionId) this.leases.delete(tabId);
    }
    for (const [cid, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.pending.delete(cid);
      }
    }
  }
}
