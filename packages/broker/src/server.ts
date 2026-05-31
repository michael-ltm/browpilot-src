import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  type Config,
  type Hello,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '@claude-browser/shared';
import { ConsoleBuffer } from './buffer.js';
import { Router } from './router.js';

const HOST = '127.0.0.1';
const DEFAULT_HEARTBEAT_MS = 30_000;

export interface ServerDeps {
  buffer?: ConsoleBuffer;
  router?: Router;
  heartbeatMs?: number;
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
}

function originAllowed(req: IncomingMessage, extensionId: string): boolean {
  const origin = req.headers.origin;
  // The node ws client (agent) sends no Origin; only browser pages carry one.
  if (origin === undefined) return true;
  return origin === `chrome-extension://${extensionId}`;
}

export function startServer(config: Config, deps: ServerDeps = {}): Promise<BrokerServer> {
  const buffer = deps.buffer ?? new ConsoleBuffer();
  const router = deps.router ?? new Router(buffer);
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const wss = new WebSocketServer({
    host: HOST,
    port: config.port,
    verifyClient: ({ req }, done) => {
      if (originAllowed(req, config.extensionId)) {
        done(true);
      } else {
        done(false, 401, 'Unauthorized');
      }
    },
  });

  /** The currently-connected and authenticated browser socket (if any). */
  let browserSocket: LiveSocket | null = null;
  const browserConnectedCallbacks = new Set<() => void>();

  wss.on('connection', (raw: WebSocket, req: IncomingMessage) => {
    const ws = raw as LiveSocket;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const browserOrigin = req.headers.origin === `chrome-extension://${config.extensionId}`;

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
        if (!browserOrigin || hello.extensionId !== config.extensionId) {
          ws.close(4001, 'UNAUTHORIZED');
          return;
        }
        ws.role = 'browser';
        browserSocket = ws;
        attachBrowser(ws, router, () => {
          // On disconnect, clear the tracked socket reference.
          if (browserSocket === ws) browserSocket = null;
        });
        // Notify listeners that the browser has (re)connected.
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
        attachAgent(ws, hello.sessionId, router);
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
          return browserSocket !== null && browserSocket.readyState === WebSocket.OPEN;
        },
        onBrowserConnected(cb: () => void): void {
          browserConnectedCallbacks.add(cb);
        },
        offBrowserConnected(cb: () => void): void {
          browserConnectedCallbacks.delete(cb);
        },
        dropBrowserConnection(): void {
          if (browserSocket !== null) {
            browserSocket.terminate();
            browserSocket = null;
          }
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

function attachBrowser(ws: LiveSocket, router: Router, onClose: () => void): void {
  router.registerBrowser((msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    router.handleBrowserMessage(msg);
  });
  ws.on('close', () => {
    onClose();
    router.onBrowserDisconnect();
  });
}

function attachAgent(ws: LiveSocket, sessionId: string, router: Router): void {
  router.registerAgent(sessionId, (msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    if ('method' in msg && 'id' in msg) {
      void router.routeRequest(sessionId, msg as JsonRpcRequest).then((resp) => {
        ws.send(JSON.stringify(resp));
      });
    }
  });
  ws.on('close', () => router.onAgentDisconnect(sessionId));
}
