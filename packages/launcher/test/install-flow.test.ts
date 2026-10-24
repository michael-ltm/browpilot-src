import { describe, it, expect } from 'vitest';
import { installExtension } from '../src/install-flow.js';
import { quitProcesses, waitForDevTools, type CdpResponse, type ProcessControl } from '../src/relaunch.js';
import type { DetectReport } from '../src/report.js';

const DIST = '/repo/extension-dist';
const WS = 'ws://127.0.0.1:9222/devtools/browser/abc';

interface FakeControl extends ProcessControl {
  spawned: Array<{ file: string; args: string[] }>;
  signals: Array<[number, string | 0]>;
  alive: Set<number>;
}

function fakeControl(over: Partial<ProcessControl> & { alive?: number[] } = {}): FakeControl {
  const alive = new Set(over.alive ?? []);
  const spawned: Array<{ file: string; args: string[] }> = [];
  const signals: Array<[number, string | 0]> = [];
  const ctrl: FakeControl = {
    spawned,
    signals,
    alive,
    kill(pid, signal) {
      signals.push([pid, signal]);
      if (signal === 0) return alive.has(pid);
      alive.delete(pid);
      return true;
    },
    sleep: async () => undefined,
    spawnDetached(file, args) {
      spawned.push({ file, args });
      return 4242;
    },
    fetchJson: async <T,>() => ({ webSocketDebuggerUrl: WS }) as T,
    cdp: async (): Promise<CdpResponse> => ({ result: { id: 'ocjnpcjkgdfgglcljkaaokfplcfpnmlj' } }),
    freePort: async () => 9222,
    ...over,
  };
  return ctrl;
}

function report(over: Partial<DetectReport> = {}): DetectReport {
  return {
    name: 'Google Chrome',
    family: 'chrome',
    executablePath: '/usr/bin/google-chrome',
    userDataDir: '/udd',
    version: 'Google Chrome 151.0.7922.169',
    isDefaultUserDataDir: false,
    profiles: [],
    running: [],
    verdict: { installed: false, path: 'cdp-load', reason: 'extension absent' },
    ...over,
  };
}

describe('installExtension', () => {
  it('does nothing at all when the extension is already enabled', async () => {
    const ctrl = fakeControl();
    const out = await installExtension(
      report({ verdict: { installed: true, path: 'already-installed', reason: 'enabled in: Work' } }),
      { extensionDir: DIST },
      ctrl,
    );
    expect(out).toMatchObject({ kind: 'already-installed' });
    expect(ctrl.spawned).toEqual([]);
    expect(ctrl.signals).toEqual([]);
  });

  it('hands back manual steps instead of touching a browser it cannot automate', async () => {
    const ctrl = fakeControl();
    const out = await installExtension(
      report({ verdict: { installed: false, path: 'manual-only', reason: 'default user data dir' } }),
      { extensionDir: DIST },
      ctrl,
    );
    expect(out.kind).toBe('manual');
    if (out.kind === 'manual') expect(out.steps.join('\n')).toContain(DIST);
    expect(ctrl.spawned).toEqual([]);
  });

  it('refuses to close a running browser unless restart was allowed', async () => {
    const ctrl = fakeControl({ alive: [999] });
    const out = await installExtension(
      report({ running: [{ pid: 999, family: 'chrome', userDataDir: '/udd', commandLine: 'chrome' }] }),
      { extensionDir: DIST },
      ctrl,
    );
    expect(out.kind).toBe('failed');
    expect(ctrl.signals).toEqual([]);
    expect(ctrl.spawned).toEqual([]);
  });

  it('quits, relaunches the real profile, and loads the extension over CDP', async () => {
    const ctrl = fakeControl({ alive: [999] });
    const out = await installExtension(
      report({ running: [{ pid: 999, family: 'chrome', userDataDir: '/udd', commandLine: 'chrome' }] }),
      { extensionDir: DIST, profileDirectory: 'Profile 1', allowRestart: true },
      ctrl,
    );
    expect(out).toMatchObject({ kind: 'loaded', pid: 4242, port: 9222, ephemeral: true });
    expect(ctrl.signals[0]).toEqual([999, 'SIGTERM']);
    expect(ctrl.spawned[0]?.file).toBe('/usr/bin/google-chrome');
    expect(ctrl.spawned[0]?.args).toContain('--user-data-dir=/udd');
    expect(ctrl.spawned[0]?.args).toContain('--profile-directory=Profile 1');
    expect(ctrl.spawned[0]?.args).toContain('--remote-debugging-port=9222');
  });

  it('starts an idle browser without sending any signal', async () => {
    const ctrl = fakeControl();
    const out = await installExtension(report(), { extensionDir: DIST, allowRestart: true }, ctrl);
    expect(out.kind).toBe('loaded');
    expect(ctrl.signals).toEqual([]);
  });

  it('falls back to manual steps when DevTools never comes up', async () => {
    const ctrl = fakeControl({ fetchJson: async () => null });
    const out = await installExtension(report(), { extensionDir: DIST, allowRestart: true }, ctrl);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.error).toContain('DevTools endpoint');
      expect(out.steps.join('\n')).toContain('Load unpacked');
    }
  });

  it('reports the CDP error when the browser refuses to load the extension', async () => {
    const ctrl = fakeControl({ cdp: async () => ({ error: { message: 'Extensions domain is disabled' } }) });
    const out = await installExtension(report(), { extensionDir: DIST, allowRestart: true }, ctrl);
    expect(out).toMatchObject({ kind: 'failed', error: 'Extensions domain is disabled' });
  });
});

describe('quitProcesses', () => {
  it('escalates to SIGKILL only for what survives the grace period', async () => {
    const ctrl = fakeControl();
    // 1 exits on SIGTERM; 2 ignores every signal.
    const stubborn = new Set([2]);
    ctrl.kill = (pid, signal) => {
      ctrl.signals.push([pid, signal]);
      if (signal === 0) return stubborn.has(pid);
      return true;
    };
    const out = await quitProcesses([1, 2], ctrl, 500, 250);
    expect(out).toEqual({ stopped: [1], forced: [2] });
    expect(ctrl.signals).toContainEqual([2, 'SIGKILL']);
    expect(ctrl.signals).not.toContainEqual([1, 'SIGKILL']);
  });

  it('sends nothing when there is nothing to stop', async () => {
    const ctrl = fakeControl();
    expect(await quitProcesses([], ctrl, 500)).toEqual({ stopped: [], forced: [] });
  });
});

describe('waitForDevTools', () => {
  it('returns the websocket url as soon as the endpoint answers', async () => {
    let calls = 0;
    const ctrl = fakeControl({
      fetchJson: async <T,>() => {
        calls += 1;
        return (calls < 3 ? null : { webSocketDebuggerUrl: WS }) as T;
      },
    });
    expect(await waitForDevTools(9222, ctrl, 5_000, 100)).toBe(WS);
    expect(calls).toBe(3);
  });

  it('gives up and returns null at the timeout', async () => {
    const ctrl = fakeControl({ fetchJson: async () => null });
    expect(await waitForDevTools(9222, ctrl, 300, 100)).toBeNull();
  });
});
