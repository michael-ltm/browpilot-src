import { describe, it, expect } from 'vitest';
import type { DetectReport, InstallOutcome } from '@browpilot/launcher';
import { detectTools, renderDetectReports, renderInstallOutcome } from '../src/tools/detect.js';
import { instanceTools } from '../src/tools/instances.js';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';

const DIST = '/repo/extension-dist';
const byName = (n: string) => detectTools.find((t) => t.name === n)!;
const installTool = instanceTools.find((t) => t.name === 'browser_install_extension')!;
const text = (res: { content: unknown[] }) => JSON.stringify(res.content);

function report(over: Partial<DetectReport> = {}): DetectReport {
  return {
    name: 'Google Chrome',
    family: 'chrome',
    executablePath: '/usr/bin/google-chrome',
    userDataDir: '/home/ada/.config/google-chrome',
    version: 'Google Chrome 151.0.7922.169',
    isDefaultUserDataDir: true,
    profiles: [],
    running: [],
    verdict: { installed: false, path: 'manual-only', reason: 'default user data dir' },
    ...over,
  };
}

describe('renderDetectReports', () => {
  it('numbers entries so browser_install_extension can be pointed at one', () => {
    const out = renderDetectReports([report(), report({ name: 'Microsoft Edge', family: 'edge' })], DIST);
    expect(out).toContain('[0] Google Chrome');
    expect(out).toContain('[1] Microsoft Edge');
  });

  it('spells out each profile and marks a custom user data dir', () => {
    const out = renderDetectReports(
      [
        report({
          userDataDir: '/home/ada/work',
          isDefaultUserDataDir: false,
          profiles: [
            {
              dir: 'Profile 1',
              name: 'Work',
              path: '/home/ada/work/Profile 1',
              extension: { state: 'enabled', source: 'Preferences', location: 4, path: DIST, disableReasons: [] },
            },
          ],
          verdict: { installed: true, path: 'already-installed', reason: 'extension enabled in: Work' },
        }),
      ],
      DIST,
    );
    expect(out).toContain('(custom)');
    expect(out).toContain('Profile 1 [Work]  enabled (unpacked)');
    expect(out).toContain('already loaded in 1 of 1');
  });

  it('points at the extension directory when nothing has it', () => {
    expect(renderDetectReports([report()], DIST)).toContain(DIST);
  });

  it('lists the pids of a running browser, since a restart would close them', () => {
    const out = renderDetectReports(
      [report({ running: [{ pid: 4242, family: 'chrome', userDataDir: '/x', commandLine: 'chrome' }] })],
      DIST,
    );
    expect(out).toContain('running:  4242');
  });
});

describe('renderInstallOutcome', () => {
  const target = report();

  it('says there is nothing to do when the extension is already there', () => {
    const out = renderInstallOutcome(target, { kind: 'already-installed', detail: 'enabled in: Work' }, DIST);
    expect(out.isError).toBeUndefined();
    expect(text(out)).toContain('nothing to do');
  });

  it('passes the manual steps through verbatim', () => {
    const outcome: InstallOutcome = { kind: 'manual', steps: ['  1. Open  chrome://extensions'], detail: 'why' };
    expect(text(renderInstallOutcome(target, outcome, DIST))).toContain('chrome://extensions');
  });

  it('warns that a CDP load does not survive the browser closing', () => {
    const outcome: InstallOutcome = { kind: 'loaded', pid: 1, port: 9222, extensionId: 'abc', ephemeral: true };
    const out = text(renderInstallOutcome(target, outcome, DIST));
    expect(out).toContain('current browser session');
    expect(out).toContain('Load unpacked');
  });

  it('marks a failure as an error and still offers the manual route', () => {
    const outcome: InstallOutcome = { kind: 'failed', error: 'no DevTools', steps: ['  1. Open  chrome://extensions'] };
    const out = renderInstallOutcome(target, outcome, DIST);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('chrome://extensions');
  });
});

describe('detect tools', () => {
  it('registers browser_detect; installation lives in the unified browser_install_extension', () => {
    expect(detectTools.map((t) => t.name)).toEqual(['browser_detect']);
  });

  it('fail loudly when the session has no pinned extension id', async () => {
    const ctx = createContext(new FakeClient());
    for (const tool of [byName('browser_detect'), installTool]) {
      const res = await tool.handler({}, ctx);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('pinned extension id');
    }
  });

  it('fail loudly when the extension directory is missing', async () => {
    const ctx = createContext(new FakeClient(), { extensionId: 'abc', extensionDir: null });
    const res = await byName('browser_detect').handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('extension directory');
  });
});
