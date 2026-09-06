import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import WebSocket from 'ws';

/** Process/clock/network effects the relaunch flow needs, injected for tests. */
export interface ProcessControl {
  /** Deliver a signal; signal 0 only probes whether the pid is alive. */
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
  sleep(ms: number): Promise<void>;
  /** Start a detached process and return its pid (null if it did not start). */
  spawnDetached(file: string, args: string[]): number | null;
  /** GET a URL, resolving to null on any failure. */
  fetchJson<T>(url: string): Promise<T | null>;
  /** Open a CDP session and run one command; resolves to the raw response. */
  cdp(wsUrl: string, method: string, params: unknown): Promise<CdpResponse>;
  /** An unused local TCP port for the DevTools endpoint. */
  freePort(): Promise<number>;
}

export interface CdpResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** The real host implementation. */
export function nodeProcessControl(overrides: Partial<ProcessControl> = {}): ProcessControl {
  return {
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal === 0 ? 0 : signal);
        return true;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawnDetached: (file, args) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return child.pid ?? null;
    },
    fetchJson: async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    },
    cdp: (wsUrl, method, params) => runCdpCommand(wsUrl, method, params),
    freePort: () =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not reserve a port'))));
        });
      }),
    ...overrides,
  };
}

/** One-shot CDP request over a fresh browser-level WebSocket session. */
function runCdpCommand(wsUrl: string, method: string, params: unknown): Promise<CdpResponse> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 15_000);
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      ws.close();
      fn();
    };
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as CdpResponse & { id?: number };
        if (msg.id === 1) finish(() => resolve(msg));
      } catch {
        /* ignore non-JSON frames */
      }
    });
    ws.on('error', (err) => finish(() => reject(err)));
  });
}

/**
 * Ask the browser to quit, then make sure it did.
 *
 * SIGTERM is what a "Quit" menu item does — Chromium flushes its profile
 * (cookies, sessions, the very state we are trying to preserve) on the way out,
 * so the hard kill is only a last resort after the grace period.
 */
export async function quitProcesses(
  pids: number[],
  ctrl: ProcessControl,
  graceMs = 10_000,
  pollMs = 250,
): Promise<{ stopped: number[]; forced: number[] }> {
  const forced: number[] = [];
  for (const pid of pids) ctrl.kill(pid, 'SIGTERM');

  const deadline = graceMs;
  let waited = 0;
  while (waited < deadline && pids.some((pid) => ctrl.kill(pid, 0))) {
    await ctrl.sleep(pollMs);
    waited += pollMs;
  }
  for (const pid of pids) {
    if (ctrl.kill(pid, 0)) {
      ctrl.kill(pid, 'SIGKILL');
      forced.push(pid);
    }
  }
  return { stopped: pids.filter((p) => !forced.includes(p)), forced };
}

interface VersionPayload {
  webSocketDebuggerUrl?: string;
}

/** Poll the DevTools endpoint until the freshly started browser answers. */
export async function waitForDevTools(
  port: number,
  ctrl: ProcessControl,
  timeoutMs = 30_000,
  pollMs = 500,
): Promise<string | null> {
  let waited = 0;
  while (waited < timeoutMs) {
    const payload = await ctrl.fetchJson<VersionPayload>(`http://127.0.0.1:${port}/json/version`);
    if (payload?.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl;
    await ctrl.sleep(pollMs);
    waited += pollMs;
  }
  return null;
}

/**
 * Load an unpacked extension into a running browser over CDP.
 *
 * This is the only automated install path left on Chrome >= 137, and it needs
 * the browser to have been started with --enable-unsafe-extension-debugging.
 * The load is per-session: the extension is gone again after the browser exits.
 */
export async function loadUnpackedOverCdp(
  wsUrl: string,
  extensionDir: string,
  ctrl: ProcessControl,
): Promise<{ ok: true; extensionId: string } | { ok: false; error: string }> {
  const res = await ctrl.cdp(wsUrl, 'Extensions.loadUnpacked', { path: extensionDir });
  if (res.error) return { ok: false, error: res.error.message ?? 'Extensions.loadUnpacked failed' };
  const id = (res.result as { id?: string } | undefined)?.id;
  if (!id) return { ok: false, error: 'Extensions.loadUnpacked returned no extension id' };
  return { ok: true, extensionId: id };
}
