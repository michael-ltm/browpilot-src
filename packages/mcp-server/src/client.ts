import WebSocket from 'ws';
import {
  DEFAULT_PORT,
  ErrorCode,
  type AgentHello,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '@claude-browser/shared';

/** Minimal socket surface the client needs; `ws` satisfies it. */
export interface ClientSocket {
  on(event: 'open', cb: () => void): this;
  on(event: 'message', cb: (data: unknown) => void): this;
  on(event: 'close', cb: () => void): this;
  on(event: 'error', cb: (err: unknown) => void): this;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => ClientSocket;

export interface BrokerClientOptions {
  port?: number;
  token: string;
  sessionId: string;
  /** Override for tests; defaults to a real `ws` WebSocket. */
  socketFactory?: SocketFactory;
}

/** A typed cross-process error matching a shared ErrorCode. */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export type NotificationListener = (method: string, params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class BrokerClient {
  private readonly port: number;
  private readonly token: string;
  private readonly sessionId: string;
  private readonly makeSocket: SocketFactory;

  private socket: ClientSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private opened = false;

  constructor(opts: BrokerClientOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.makeSocket =
      opts.socketFactory ??
      ((url) => new WebSocket(url) as unknown as ClientSocket);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Open the socket and wire handlers. Sends AgentHello on 'open'. */
  connect(): void {
    const socket = this.makeSocket(this.url);
    this.socket = socket;
    socket.on('open', () => {
      this.opened = true;
      const hello: AgentHello = {
        type: 'hello',
        role: 'agent',
        token: this.token,
        sessionId: this.sessionId,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => {
      /* surfaced via 'close'; per-request timeouts cover hangs */
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Issue a JSON-RPC request; rejects with RpcError(TIMEOUT) after timeoutMs. */
  request<R = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<R> {
    if (!this.socket) {
      return Promise.reject(
        new RpcError(ErrorCode.EXTENSION_DISCONNECTED, 'not connected to broker'),
      );
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(ErrorCode.TIMEOUT, `request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify(req));
    });
  }

  close(): void {
    this.socket?.close();
  }

  private handleMessage(data: unknown): void {
    let msg: JsonRpcMessage;
    try {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : String(data);
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return; // ignore unparseable frames
    }

    // Notification: has a method, no id.
    if ('method' in msg && !('id' in msg)) {
      for (const l of this.notificationListeners) l(msg.method, (msg as { method: string; params?: unknown }).params);
      return;
    }

    if (!('id' in msg) || msg.id === null || typeof msg.id === 'string') {
      // We only ever issue numeric ids; ignore anything else.
      if (typeof msg.id !== 'number') return;
    }
    const id = msg.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if ('error' in msg && msg.error) {
      pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else if ('result' in msg) {
      pending.resolve((msg as { result: unknown }).result);
    }
  }

  private handleClose(): void {
    this.opened = false;
    const err = new RpcError(
      ErrorCode.EXTENSION_DISCONNECTED,
      'broker connection closed',
    );
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
