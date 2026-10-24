import { pathToFileURL } from 'node:url';
import type { Config } from '@browpilot/shared';
import { loadConfig } from './config.js';
import { startServer, type BrokerServer } from './server.js';

// Re-export library API so consumers (e.g. scripts/install.ts) can import
// from '@browpilot/broker' without reaching into internal modules.
export { startServer } from './server.js';
export type { BrokerServer, ServerDeps } from './server.js';
export { renderLaunchdPlist, LAUNCHD_LABEL } from './launchd.js';
export type { LaunchdOptions } from './launchd.js';

/**
 * How long to wait for the listening socket before assuming another broker
 * already owns the port and bailing out. The winning broker binds in well under
 * a second; anything slower than this is a loser of a startup race.
 */
const BIND_TIMEOUT_MS = 5_000;

export interface BrokerDaemonDeps {
  loadConfig?: () => Config;
  startServer?: (config: Config) => Promise<BrokerServer>;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  bindTimeoutMs?: number;
  /** Invoked once the server is listening (test/observability hook). */
  onReady?: (server: BrokerServer) => void;
}

/**
 * Run the broker as a singleton daemon.
 *
 * The broker is meant to be a single shared process on a fixed port. When many
 * MCP sessions start at once they each spawn a broker; only one can bind the
 * port. The losers MUST exit, otherwise they linger as zombie node processes —
 * on Windows the `ws` server has been observed to emit neither `listening` nor
 * `error` for a port-in-use bind, leaving the start promise pending forever and
 * the process alive (observed: 107 leaked brokers eating ~9GB). A self-arming
 * watchdog guarantees termination regardless of why the bind never completes.
 */
export async function runBrokerDaemon(deps: BrokerDaemonDeps = {}): Promise<void> {
  const loadCfg = deps.loadConfig ?? loadConfig;
  const start = deps.startServer ?? startServer;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message)); // eslint-disable-line no-console
  const bindTimeoutMs = deps.bindTimeoutMs ?? BIND_TIMEOUT_MS;

  const config = loadCfg();

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const watchdog = setTimeout(() => {
      if (settled) return;
      log(
        `[browpilot-broker] not listening within ${bindTimeoutMs}ms; another broker already owns the port — exiting`,
      );
      exit(0);
      finish();
    }, bindTimeoutMs);
    watchdog.unref?.();

    start(config).then(
      (server) => {
        if (settled) {
          // The watchdog already gave up on us; close the late-opening server
          // so we never leave two listeners behind.
          void server.close().catch(() => {});
          return;
        }
        clearTimeout(watchdog);
        log(`[browpilot-broker] listening on ws://${server.host}:${server.port}`);
        const shutdown = (signal: string): void => {
          log(`[browpilot-broker] ${signal} received, shutting down`);
          void server.close().then(() => exit(0));
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        deps.onReady?.(server);
        finish();
      },
      (err: unknown) => {
        if (settled) return;
        clearTimeout(watchdog);
        const code = (err as { code?: string }).code;
        if (code === 'EADDRINUSE') {
          // Losing the bind race is the normal "already running" case — a broker
          // is already serving the port, so this one's job is done.
          log('[browpilot-broker] port already in use; another broker is running — exiting');
          exit(0);
          finish();
          return;
        }
        // eslint-disable-next-line no-console
        console.error('[browpilot-broker] fatal:', err);
        exit(1);
        finish();
      },
    );
  });
}

// Only run the daemon when this module is the process entry point. Importing the
// library barrel (scripts/install.ts, the integration harness) must NOT start a
// server or call process.exit.
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  void runBrokerDaemon();
}
