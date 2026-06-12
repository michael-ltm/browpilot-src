import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@claude-browser/shared';
import { runBrokerDaemon } from '../src/index.js';
import type { BrokerServer } from '../src/server.js';

const config: Config = { port: 8787, token: 'secret-token', extensionId: 'pinnedextid' };

function fakeServer(overrides: Partial<BrokerServer> = {}): BrokerServer {
  return {
    port: 8787,
    host: '127.0.0.1',
    router: {} as BrokerServer['router'],
    close: async () => {},
    hasBrowserConnection: () => false,
    onBrowserConnected: () => {},
    offBrowserConnected: () => {},
    dropBrowserConnection: () => {},
    ...overrides,
  };
}

describe('runBrokerDaemon', () => {
  it('exits 0 when the port is already in use (another broker already won)', async () => {
    const exit = vi.fn();
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    await runBrokerDaemon({
      loadConfig: () => config,
      startServer: () => Promise.reject(err),
      exit,
      bindTimeoutMs: 1000,
      log: () => {},
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 0 when startServer never reaches listening within the bind timeout (Windows zombie guard)', async () => {
    const exit = vi.fn();
    await runBrokerDaemon({
      loadConfig: () => config,
      // Mimics the observed Windows failure: neither "listening" nor "error" ever fires.
      startServer: () => new Promise<BrokerServer>(() => {}),
      exit,
      bindTimeoutMs: 20,
      log: () => {},
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('closes the server if it opens only after the watchdog already fired', async () => {
    const exit = vi.fn();
    const close = vi.fn(async () => {});
    let resolveStart!: (s: BrokerServer) => void;
    await runBrokerDaemon({
      loadConfig: () => config,
      startServer: () => new Promise<BrokerServer>((r) => { resolveStart = r; }),
      exit,
      bindTimeoutMs: 20,
      log: () => {},
    });
    // Watchdog fired and exited; now the bind belatedly succeeds.
    resolveStart(fakeServer({ close }));
    await Promise.resolve();
    expect(close).toHaveBeenCalled();
  });

  it('does not exit and reports ready once the server is listening', async () => {
    const exit = vi.fn();
    const server = fakeServer();
    let ready: BrokerServer | null = null;
    await runBrokerDaemon({
      loadConfig: () => config,
      startServer: () => Promise.resolve(server),
      exit,
      bindTimeoutMs: 1000,
      log: () => {},
      onReady: (s) => { ready = s; },
    });
    expect(exit).not.toHaveBeenCalled();
    expect(ready).toBe(server);
  });
});
