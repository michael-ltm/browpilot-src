import {
  type BrowserHello,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type OnStatusParams,
  ErrorCode,
  Method,
} from '@claude-browser/shared';

export const RECONNECT_ALARM = 'claude-browser-reconnect';
export const STATUS_KEY = 'claudeBrowserStatus';

const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_MS = 30000;
const PONG_TIMEOUT_MS = 3000;

export interface TransportOptions {
  port: number;
  extensionId: string;
  instanceId: string;
  label: string;
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => void;
type RpcError = { code: number; message: string; data?: unknown };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcError) => void;
}

/**
 * WS client + minimal JSON-RPC peer for the extension side.
 * Owns the Codex-grade reconnect discipline: dual setTimeout + chrome.alarms,
 * 30s heartbeat with a 3s pong deadline, and status mirrored to chrome.storage.local.
 */
export class Transport {
  private readonly opts: TransportOptions;
  private ws: WebSocket | null = null;
  private everConnected = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TransportOptions) {
    this.opts = opts;
  }

  registerHandler(method: string, fn: RequestHandler): void {
    this.requestHandlers.set(method, fn);
  }

  onNotification(method: string, fn: NotificationHandler): void {
    this.notificationHandlers.set(method, fn);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    // Guard all non-terminal states to prevent orphaned sockets.
    // readyState: CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === 0 || this.ws.readyState === 2)) return;
    this.clearReconnectTimer();
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}`);
    this.ws = ws;
    ws.onopen = () => {
      this.everConnected = true;
      const hello: BrowserHello = { type: 'hello', role: 'browser', extensionId: this.opts.extensionId, instanceId: this.opts.instanceId, label: this.opts.label };
      ws.send(JSON.stringify(hello));
      void this.setStatus('connected');
      void chrome.alarms.clear(RECONNECT_ALARM);
      this.startHeartbeat();
    };
    ws.onmessage = (ev: { data: string }) => this.handleMessage(ev.data);
    ws.onerror = () => {
      /* errors surface via onclose; nothing to do here */
    };
    ws.onclose = () => this.handleClose();
  }

  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject({ code: ErrorCode.EXTENSION_DISCONNECTED, message: 'socket not open' });
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(req));
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.ws.send(JSON.stringify(notif));
  }

  private handleMessage(data: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return;
    }
    if ('id' in msg && 'result' in msg) {
      this.resolvePending(msg as JsonRpcSuccess);
      return;
    }
    if ('id' in msg && 'error' in msg) {
      this.rejectPending(msg as JsonRpcErrorResponse);
      return;
    }
    if ('method' in msg && 'id' in msg) {
      void this.dispatchRequest(msg as JsonRpcRequest);
      return;
    }
    if ('method' in msg) {
      this.dispatchNotification(msg as JsonRpcNotification);
    }
  }

  private resolvePending(msg: JsonRpcSuccess): void {
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(msg.result);
  }

  private rejectPending(msg: JsonRpcErrorResponse): void {
    if (msg.id === null) return;
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(msg.error);
  }

  private async dispatchRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    if (!handler) {
      this.replyError(req.id, { code: ErrorCode.METHOD_NOT_FOUND, message: `no handler: ${req.method}` });
      return;
    }
    try {
      const result = await handler(req.params);
      const ok: JsonRpcSuccess = { jsonrpc: '2.0', id: req.id, result };
      this.ws?.send(JSON.stringify(ok));
    } catch (err) {
      this.replyError(req.id, this.toRpcError(err));
    }
  }

  private dispatchNotification(notif: JsonRpcNotification): void {
    const handler = this.notificationHandlers.get(notif.method);
    handler?.(notif.params);
  }

  private replyError(id: number | string, error: RpcError): void {
    const res: JsonRpcErrorResponse = { jsonrpc: '2.0', id, error };
    this.ws?.send(JSON.stringify(res));
  }

  private toRpcError(err: unknown): RpcError {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      const e = err as RpcError;
      return { code: e.code, message: e.message, data: e.data };
    }
    return { code: ErrorCode.INTERNAL, message: err instanceof Error ? err.message : String(err) };
  }

  private handleClose(): void {
    this.stopHeartbeat();
    // Reject all in-flight calls so the agent retries instead of hanging.
    for (const [, p] of this.pending) {
      p.reject({ code: ErrorCode.EXTENSION_DISCONNECTED, message: 'extension socket closed' });
    }
    this.pending.clear();
    this.ws = null;
    // Distinguish "never connected yet" (no broker / no Claude session running)
    // from a genuine drop, so the popup shows a calm "waiting" rather than the
    // alarming "reconnecting" when the user simply hasn't started a session.
    void this.setStatus(this.everConnected ? 'reconnecting' : 'waiting');
    this.scheduleReconnect();
  }

  /** Fire BOTH a 5s setTimeout AND a chrome.alarms alarm that survives SW death. */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private beat(): void {
    if (!this.isConnected()) return;
    // Activity resets the MV3 idle timer; a missing pong reveals a half-open socket.
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.ws?.close();
    }, PONG_TIMEOUT_MS);
    this.sendRequest(Method.PING)
      .then(() => {
        if (this.pongTimer !== null) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      })
      .catch(() => {
        /* close() path already handles teardown */
      });
  }

  private async setStatus(state: OnStatusParams['state'], detail?: string): Promise<void> {
    const status: OnStatusParams = detail ? { state, detail } : { state };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
  }
}
