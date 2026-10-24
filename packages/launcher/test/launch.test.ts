import { describe, it, expect } from 'vitest';
import { buildLaunchFlags, extensionsPageUrl, loadExtensionFlagSupported, manualInstallSteps } from '../src/launch.js';
import type { BrowserReport, ProfileExtensionStatus } from '../src/types.js';

const DIST = '/repo/extension-dist';

function profile(state: 'enabled' | 'disabled' | 'absent', name = 'Personal'): ProfileExtensionStatus {
  return {
    dir: 'Default',
    name,
    path: '/udd/Default',
    extension: { state, source: state === 'absent' ? null : 'Preferences', location: 4, path: DIST, disableReasons: [] },
  };
}

function report(over: Partial<BrowserReport> = {}): BrowserReport {
  return {
    name: 'Google Chrome',
    family: 'chrome',
    executablePath: '/usr/bin/google-chrome',
    userDataDir: '/udd',
    version: 'Google Chrome 151.0.7922.169',
    isDefaultUserDataDir: true,
    profiles: [],
    ...over,
  };
}

describe('buildLaunchFlags', () => {
  it('points at the real user data dir and profile, keeping the user signed in', () => {
    const flags = buildLaunchFlags({ extensionDir: DIST, userDataDir: '/udd', profileDirectory: 'Profile 1' });
    expect(flags).toEqual([
      '--user-data-dir=/udd',
      '--profile-directory=Profile 1',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });

  it('never disables the user’s other extensions', () => {
    const flags = buildLaunchFlags({ extensionDir: DIST, userDataDir: '/udd', remoteDebuggingPort: 9222 });
    expect(flags.some((f) => f.startsWith('--disable-extensions'))).toBe(false);
  });

  it('opens DevTools on loopback and unlocks the extension domain when a port is given', () => {
    const flags = buildLaunchFlags({ extensionDir: DIST, userDataDir: '/udd', remoteDebuggingPort: 9222 });
    expect(flags).toContain('--remote-debugging-port=9222');
    expect(flags).toContain('--remote-debugging-address=127.0.0.1');
    expect(flags).toContain('--enable-unsafe-extension-debugging');
  });

  it('omits --load-extension unless the caller says the build still honours it', () => {
    const without = buildLaunchFlags({ extensionDir: DIST, userDataDir: '/udd' });
    expect(without.some((f) => f.startsWith('--load-extension'))).toBe(false);
    const with_ = buildLaunchFlags({ extensionDir: DIST, userDataDir: '/udd', useLoadExtensionFlag: true });
    expect(with_).toContain(`--load-extension=${DIST}`);
  });

  it('appends extra flags verbatim', () => {
    const flags = buildLaunchFlags({ extensionDir: DIST, userDataDir: '/udd', extraFlags: ['--no-sandbox'] });
    expect(flags.at(-1)).toBe('--no-sandbox');
  });
});

describe('loadExtensionFlagSupported', () => {
  it('is true only below the 137 removal, and false when the version is unknown', () => {
    expect(loadExtensionFlagSupported('Google Chrome 136.0.0.0')).toBe(true);
    expect(loadExtensionFlagSupported('Google Chrome 137.0.0.0')).toBe(false);
    expect(loadExtensionFlagSupported('Google Chrome 151.0.7922.169')).toBe(false);
    expect(loadExtensionFlagSupported(null)).toBe(false);
  });
});

describe('extensionsPageUrl', () => {
  it('uses the browser’s own scheme', () => {
    expect(extensionsPageUrl({ family: 'edge' })).toBe('edge://extensions');
    expect(extensionsPageUrl({ family: 'chrome' })).toBe('chrome://extensions');
    expect(extensionsPageUrl({ family: 'brave' })).toBe('chrome://extensions');
  });
});

describe('manualInstallSteps', () => {
  it('walks through Developer mode + Load unpacked when nothing is installed', () => {
    const text = manualInstallSteps(report(), DIST).join('\n');
    expect(text).toContain('chrome://extensions');
    expect(text).toContain('Developer mode');
    expect(text).toContain(DIST);
  });

  it('just asks for a re-enable when the extension is only switched off', () => {
    const text = manualInstallSteps(report({ profiles: [profile('disabled', 'Work')] }), DIST).join('\n');
    expect(text).toContain('switched off');
    expect(text).toContain('Work');
    expect(text).not.toContain('Developer mode');
  });
});
