import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpMcpOptions {
  port: number;
  token: string;
  allowedOrigins?: string[];
  createSession(): { server: McpServer; dispose(): void | Promise<void> };
}

/** Loopback HTTP MCP; a tunnel forwards this endpoint, never the broker socket. */
export async function startHttpMcp(options: HttpMcpOptions): Promise<{ port: number; close(): Promise<void> }> {
  if (options.token.length < 32) throw new Error('BROWPILOT_HTTP_TOKEN must contain at least 32 characters');
  const expected = Buffer.from(`Bearer ${options.token}`);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; touched: number; close(): Promise<void> }>();
  const active = new Set<() => Promise<void>>();
  let shuttingDown = false;
  let shutdown: Promise<void> | undefined;
  const reply = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) return reply(res, 503, 'Server is shutting down');
    if (req.url !== '/mcp') return reply(res, 404, 'Not found');
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(res, 401, 'Bearer authentication required');
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins?.includes(origin)) return reply(res, 403, 'Origin not allowed');
    const host = req.headers.host ?? '';
    const allowedHosts = new Set(['127.0.0.1', 'localhost', ...((options.allowedOrigins ?? []).map((v) => new URL(v).hostname))]);
    if (!allowedHosts.has(host.split(':')[0]!)) return reply(res, 403, 'Host not allowed');
    const id = req.headers['mcp-session-id'];
    if (id !== undefined && typeof id !== 'string') return reply(res, 400, 'Invalid session');
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) return reply(res, 405, 'Method not allowed');
    let body: unknown;
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, 'Expected application/json');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1_048_576) return reply(res, 413, 'Request exceeds 1 MiB');
        chunks.push(Buffer.from(chunk));
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(res, 400, 'Invalid JSON'); }
    }
    if (id) {
      const session = sessions.get(id);
      if (!session) return reply(res, 404, 'Unknown or expired session');
      session.touched = Date.now();
      await session.transport.handleRequest(req, res, body);
      if (req.method === 'DELETE') await session.close();
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) return reply(res, 400, 'Initialize a session first');
    if (shuttingDown) return reply(res, 503, 'Server is shutting down');
    if (active.size >= 100) return reply(res, 503, 'Session limit reached');
    const resource = options.createSession();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        // Defer work so recursive transport.onclose observes the same promise.
        closing = Promise.resolve().then(async () => {
          try { await resource.server.close(); }
          finally { await resource.dispose(); }
        }).finally(() => { active.delete(close); });
      }
      return closing;
    };
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId): void => { sessions.set(sessionId, { transport, touched: Date.now(), close }); },
    });
    active.add(close);
    try {
      await resource.server.connect(transport);
      const previousClose = transport.onclose;
      transport.onclose = () => { previousClose?.(); void close().catch(() => {}); };
      await transport.handleRequest(req, res, body);
      if (!transport.sessionId) await close();
    } catch (err) { await close(); throw err; }
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, 'MCP request failed'); else res.end(); });
  });
  server.requestTimeout = 60_000;
  const sweep = setInterval(() => {
    for (const session of sessions.values()) if (Date.now() - session.touched > 30 * 60_000) void session.close().catch(() => {});
  }, 60_000);
  sweep.unref();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  } catch (error) { clearInterval(sweep); throw error; }
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : options.port,
    async close() {
      if (!shutdown) {
        shuttingDown = true;
        clearInterval(sweep);
        const stopped = new Promise<void>(resolve => server.close(() => resolve()));
        shutdown = Promise.allSettled([...active].map(close => close())).then(async () => {
          server.closeAllConnections();
          await stopped;
        });
      }
      await shutdown;
    },
  };
}
