import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  type Config,
  type Hello,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '@claude-browser/shared';
import { Router } from './router.js';
import { ProfileRegistry } from './profiles.js';
import { CONFIG_DIR, Method } from '@claude-browser/shared';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalBrowserManager } from './local/index.js';
import { routeWithLifecycle } from './lifecycle-rpc.js';
import { withReleaseDefaults } from './release-config.js';

const HOST = '127.0.0.1';
const DEFAULT_HEARTBEAT_MS = 30_000;

export interface ServerDeps {
  router?: Router;
  registry?: ProfileRegistry;
  heartbeatMs?: number;
  localManager?: LocalBrowserManager;
}

export interface BrokerServer {
  readonly port: number;
  readonly host: string;
  readonly router: Router;
  close(): Promise<void>;
  /** Returns true when a browser socket is connected and authenticated. */
  hasBrowserConnection(): boolean;
  /** Fires when the browser (re)connects. */
  onBrowserConnected(cb: () => void): void;
  offBrowserConnected(cb: () => void): void;
  /** Force-close the current browser socket (soak-test hook). */
  dropBrowserConnection(): void;
}

interface LiveSocket extends WebSocket {
  isAlive: boolean;
  role?: 'browser' | 'agent';
  sessionId?: string;
  browserId?: string;
}

function originAllowed(req: IncomingMessage, extensionIds: string[]): boolean {
  const origin = req.headers.origin;
  // The node ws client (agent) sends no Origin; only browser pages carry one.
  if (origin === undefined) return true;
  return extensionIds.some(id => origin === `chrome-extension://${id}`);
}

export function startServer(config: Config, deps: ServerDeps = {}): Promise<BrokerServer> {
  config = withReleaseDefaults(config);
  const registry = deps.registry ?? new ProfileRegistry();
  const router = deps.router ?? new Router(registry);
  const extensionIds = [...new Set([config.extensionId, ...(config.extensionIds ?? [])])];
  const local = deps.localManager ?? new LocalBrowserManager({ configDir: join(homedir(), CONFIG_DIR), extensionIds, storeUrls: config.storeUrls, connectedIds: () => router.connectedBrowserIds() });
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const wss = new WebSocketServer({
    host: HOST,
    port: config.port,
    verifyClient: ({ req }, done) => {
      if (originAllowed(req, extensionIds)) {
        done(true);
      } else {
        done(false, 401, 'Unauthorized');
      }
    },
  });

  const browsers = new Map<string, LiveSocket>();
  const browserConnectedCallbacks = new Set<() => void>();

  wss.on('connection', (raw: WebSocket, req: IncomingMessage) => {
    const ws = raw as LiveSocket;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const browserOrigin = req.headers.origin;

    ws.once('message', (data: RawData) => {
      let hello: Hello;
      try {
        hello = JSON.parse(data.toString()) as Hello;
      } catch {
        ws.close(4002, 'bad hello');
        return;
      }

      if (hello.type !== 'hello') {
        ws.close(4002, 'expected hello');
        return;
      }

      if (hello.role === 'browser') {
        if (!extensionIds.includes(hello.extensionId) || browserOrigin !== `chrome-extension://${hello.extensionId}` || typeof hello.instanceId !== 'string' || !hello.instanceId || typeof hello.label !== 'string') {
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
        attachBrowser(ws, browserId, router, local, () => {
          if (browsers.get(browserId) === ws) {
            browsers.delete(browserId);
            return true;
          }
          return false;
        });
        router.announceProfileChange(browserId);
        for (const cb of browserConnectedCallbacks) cb();
        return;
      }

      if (hello.role === 'agent') {
        if (hello.token !== config.token) {
          ws.close(4001, 'UNAUTHORIZED');
          return;
        }
        ws.role = 'agent';
        ws.sessionId = hello.sessionId;
        attachAgent(ws, hello.sessionId, router, local);
        return;
      }

      ws.close(4002, 'unknown role');
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as LiveSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return new Promise<BrokerServer>((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;
      resolve({
        port,
        host: HOST,
        router,
        hasBrowserConnection(): boolean {
          for (const ws of browsers.values()) if (ws.readyState === WebSocket.OPEN) return true;
          return false;
        },
        onBrowserConnected(cb: () => void): void {
          browserConnectedCallbacks.add(cb);
        },
        offBrowserConnected(cb: () => void): void {
          browserConnectedCallbacks.delete(cb);
        },
        dropBrowserConnection(): void {
          for (const ws of browsers.values()) ws.terminate();
          browsers.clear();
        },
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const c of wss.clients) (c as WebSocket).terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

function attachBrowser(ws: LiveSocket, browserId: string, router: Router, local: LocalBrowserManager, onClose: () => boolean): void {
  router.registerBrowser(browserId, (msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    if ('method' in msg && msg.method === Method.PAIR_LOCAL_PROFILE && 'id' in msg) {
      const nonce = (msg.params as { nonce?: unknown } | undefined)?.nonce;
      void (typeof nonce === 'string' ? local.pair(nonce, browserId) : Promise.resolve(false))
        .then(ok => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { paired: ok } })); })
        .catch(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 1000, message: 'Could not persist profile pairing' } })); });
      return;
    }
    router.handleBrowserMessage(browserId, msg);
  });
  ws.on('close', () => {
    // A same-instanceId reconnect replaces this socket synchronously; the stale
    // socket's async close must NOT tear down the new registration. Only run the
    // router disconnect when this ws is still the live socket for the profile.
    if (onClose()) router.onBrowserDisconnect(browserId);
  });
}

function attachAgent(ws: LiveSocket, sessionId: string, router: Router, local: LocalBrowserManager): void {
  router.registerAgent(sessionId, (msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    if ('method' in msg && 'id' in msg) {
      void routeWithLifecycle(router, local, sessionId, msg as JsonRpcRequest).then((resp) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp));
      });
    }
  });
  ws.on('close', () => router.onAgentDisconnect(sessionId));
}
