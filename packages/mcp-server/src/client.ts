import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  DEFAULT_PORT,
  ErrorCode,
  type AgentHello,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '@browpilot/shared';

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
  /** Override for tests; defaults to spawning the broker bin detached. */
  spawnBroker?: () => void;
  /** Override for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
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

/** Locate the broker entry in both the packaged (co-located) and dev (monorepo) layouts. */
export function resolveBrokerEntry(here: string, exists: (p: string) => boolean = existsSync): string {
  const packaged = resolvePath(here, 'broker.js'); // published: dist/mcp.js + dist/broker.js
  if (exists(packaged)) return packaged;
  const dev = resolvePath(here, '../../broker/dist/index.js'); // monorepo dev
  if (exists(dev)) return dev;
  throw new Error(`broker entry not found (looked at ${packaged} and ${dev})`);
}

/** Spawn the broker bin detached so it outlives this MCP process (cross-platform). */
function defaultSpawnBroker(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const brokerEntry = resolveBrokerEntry(here);
  const child = spawn(process.execPath, [brokerEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // no console flash on Windows
  });
  child.unref();
}

export class BrokerClient {
  private readonly port: number;
  private readonly token: string;
  private readonly sessionId: string;
  private readonly makeSocket: SocketFactory;
  private readonly spawnBroker: () => void;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private brokerSpawned = false;
  private reconnecting = false;
  private destroyed = false;
  private connectionTask?: Promise<void>;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private stopRetry!: () => void;
  private readonly stopped = new Promise<void>(resolve => { this.stopRetry = resolve; });

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
    this.spawnBroker = opts.spawnBroker ?? defaultSpawnBroker;
    this.delay =
      opts.delay ?? ((ms: number) => new Promise((r) => { this.backoffTimer = setTimeout(r, ms); }));
    this.baseBackoffMs = opts.baseBackoffMs ?? 200;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5_000;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Connect, retrying with capped backoff. On the first ECONNREFUSED, spawn the
   * broker detached (once). Resolves when the socket opens.
   */
  connectWithRetry(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (!this.connectionTask) this.connectionTask = this.retryConnection().finally(() => { this.connectionTask = undefined; });
    return this.connectionTask;
  }

  private async retryConnection(): Promise<void> {
    let attempt = 0;
    while (!this.destroyed) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        if (this.destroyed) return;
        const code = (err as { code?: string }).code;
        if (code === 'ECONNREFUSED' && !this.brokerSpawned) {
          this.brokerSpawned = true;
          this.spawnBroker();
        }
        const backoff = Math.min(
          this.baseBackoffMs * 2 ** attempt,
          this.maxBackoffMs,
        );
        attempt++;
        await Promise.race([this.delay(backoff), this.stopped]);
      }
    }
  }

  /** Single connection attempt; resolves on 'open', rejects on 'error'. */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.makeSocket(this.url);
      this.socket = socket;
      let settled = false;
      let didOpen = false;
      socket.on('open', () => {
        if (this.destroyed || this.socket !== socket) { socket.close(); return; }
        didOpen = true;
        this.opened = true;
        const hello: AgentHello = {
          type: 'hello',
          role: 'agent',
          token: this.token,
          sessionId: this.sessionId,
        };
        socket.send(JSON.stringify(hello));
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err as Error);
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.handleClose();
        if (!settled) {
          settled = true;
          reject(new RpcError(ErrorCode.EXTENSION_DISCONNECTED, 'closed before open'));
          return;
        }
        if (this.destroyed) {
          // Intentional teardown via close() — do not reconnect.
          return;
        }
        if (didOpen && !this.reconnecting) {
          this.reconnecting = true;
          // Reset the spawn latch so that a subsequent ECONNREFUSED (e.g. the
          // broker crashed) will trigger a fresh spawn rather than looping forever
          // with no broker to connect to.
          this.brokerSpawned = false;
          void this.connectWithRetry().catch(() => {}).finally(() => {
            this.reconnecting = false;
          });
        } else if (!settled) {
          settled = true;
          reject(new RpcError(ErrorCode.EXTENSION_DISCONNECTED, 'closed before open'));
        }
      });
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
    if (!this.socket || this.destroyed || !this.opened) {
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
    this.destroyed = true;
    this.stopRetry();
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.socket?.close();
    this.handleClose();
    this.notificationListeners.clear();
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
      if (!msg || typeof msg !== 'object') return;
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
