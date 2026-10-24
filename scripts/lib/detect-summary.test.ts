import { describe, it, expect } from 'vitest';
import type { DetectReport } from '@browpilot/launcher';
import { summarizeDetection } from './detect-summary.js';

const DIST = '/repo/packages/extension/dist';

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

describe('summarizeDetection', () => {
  it('says so plainly when the machine has no Chromium-family browser', () => {
    expect(summarizeDetection([], DIST).join('\n')).toContain('No Chromium-family browser');
  });

  it('stops at "nothing else to do" once any browser has the extension', () => {
    const out = summarizeDetection(
      [report({ verdict: { installed: true, path: 'already-installed', reason: 'enabled in: Work' } })],
      DIST,
    ).join('\n');
    expect(out).toContain('[ok]');
    expect(out).toContain('nothing else to do');
    expect(out).not.toContain('Developer mode');
  });

  it('prints the one manual step left when nothing has it yet', () => {
    const out = summarizeDetection([report()], DIST).join('\n');
    expect(out).toContain('[todo]');
    expect(out).toContain('Developer mode');
    expect(out).toContain(DIST);
    expect(out).toContain('browser_install_extension');
  });

  it('lists every profile it inspected', () => {
    const out = summarizeDetection(
      [
        report({
          profiles: [
            {
              dir: 'Default',
              name: 'Personal',
              path: '/p',
              extension: { state: 'absent', source: null, location: null, path: null, disableReasons: [] },
            },
          ],
        }),
      ],
      DIST,
    ).join('\n');
    expect(out).toContain('Default [Personal]  not installed');
  });
});
