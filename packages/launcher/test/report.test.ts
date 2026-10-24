import { describe, it, expect } from 'vitest';
import { fakeEnv, localState, prefsWithExtension } from './fake-env.js';
import { detectAll, describeProfile, inspectBrowser, verdictFor } from '../src/report.js';
import type { BrowserInstall, BrowserReport } from '../src/types.js';

const EXT = 'ocjnpcjkgdfgglcljkaaokfplcfpnmlj';
const UDD = '/home/ada/.config/google-chrome';

const INSTALL: BrowserInstall = {
  name: 'Google Chrome',
  family: 'chrome',
  executablePath: '/usr/bin/google-chrome',
  userDataDir: UDD,
  version: 'Google Chrome 151.0.7922.169',
  isDefaultUserDataDir: true,
};

function report(over: Partial<BrowserReport> = {}): BrowserReport {
  return { ...INSTALL, profiles: [], ...over };
}

describe('inspectBrowser', () => {
  it('pairs each profile with its extension state', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      files: {
        [`${UDD}/Local State`]: localState({ Default: 'Personal', 'Profile 1': 'Work' }),
        [`${UDD}/Default/Preferences`]: '{}',
        [`${UDD}/Profile 1/Preferences`]: prefsWithExtension(EXT, { location: 4, path: '/repo/extension-dist' }),
      },
    });
    const out = inspectBrowser(INSTALL, EXT, env);
    expect(out.profiles.map((p) => [p.dir, p.extension.state])).toEqual([
      ['Default', 'absent'],
      ['Profile 1', 'enabled'],
    ]);
  });

  it('reports an error instead of throwing for a user data dir that is not there', () => {
    const env = fakeEnv({ platform: 'linux', home: '/home/ada' });
    const out = inspectBrowser(INSTALL, EXT, env);
    expect(out.profiles).toEqual([]);
    expect(out.error).toContain('user data dir not found');
  });
});

describe('verdictFor', () => {
  const env = fakeEnv({ platform: 'linux', home: '/home/ada' });

  it('is detect-first: an enabled profile means do nothing', () => {
    const v = verdictFor(
      report({
        profiles: [
          {
            dir: 'Profile 1',
            name: 'Work',
            path: `${UDD}/Profile 1`,
            extension: { state: 'enabled', source: 'Preferences', location: 4, path: '/d', disableReasons: [] },
          },
        ],
      }),
      env,
    );
    expect(v).toMatchObject({ installed: true, path: 'already-installed' });
    expect(v.reason).toContain('Work');
  });

  it('asks the user to re-enable a disabled extension rather than relaunching', () => {
    const v = verdictFor(
      report({
        profiles: [
          {
            dir: 'Default',
            name: 'Personal',
            path: `${UDD}/Default`,
            extension: {
              state: 'disabled',
              source: 'Preferences',
              location: 4,
              path: '/d',
              disableReasons: ['DISABLE_USER_ACTION'],
            },
          },
        ],
      }),
      env,
    );
    expect(v).toMatchObject({ installed: false, path: 'manual-only' });
    expect(v.reason).toContain('turned off');
  });

  it('is manual-only on modern Chrome using its default user data dir', () => {
    const v = verdictFor(report({ profiles: [] }), env);
    expect(v.path).toBe('manual-only');
    expect(v.reason).toContain('remote debugging');
  });

  it('allows the CDP load path for a custom user data dir', () => {
    const v = verdictFor(report({ isDefaultUserDataDir: false }), env);
    expect(v.path).toBe('cdp-load');
  });

  it('allows the CDP load path on browsers older than the 136 clamp-down', () => {
    const v = verdictFor(report({ version: 'Google Chrome 120.0.0.0' }), env);
    expect(v.path).toBe('cdp-load');
  });
});

describe('detectAll', () => {
  it('folds detection, profiles, extension state and live processes together', () => {
    const custom = '/home/ada/work-profile';
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/usr/bin' },
      files: {
        '/usr/bin/google-chrome': '',
        [`${UDD}/Local State`]: localState({ Default: 'Personal' }),
        [`${UDD}/Default/Preferences`]: '{}',
        [`${custom}/Local State`]: localState({ Default: 'Work' }),
        [`${custom}/Default/Preferences`]: prefsWithExtension(EXT),
      },
      commands: {
        '/usr/bin/google-chrome --version': 'Google Chrome 151.0.7922.169',
        'ps -eo pid=,args=': ` 4242 /opt/google/chrome/chrome --user-data-dir=${custom}\n`,
      },
    });

    const reports = detectAll(EXT, env);
    expect(reports.map((r) => r.userDataDir)).toEqual([UDD, custom]);

    const [stock, work] = reports;
    expect(stock?.verdict).toMatchObject({ installed: false, path: 'manual-only' });
    expect(stock?.running).toEqual([]);
    expect(work?.verdict).toMatchObject({ installed: true, path: 'already-installed' });
    expect(work?.running.map((p) => p.pid)).toEqual([4242]);
  });
});

describe('describeProfile', () => {
  it('spells out how the extension got there', () => {
    const base = { dir: 'Default', name: 'Personal', path: `${UDD}/Default` };
    expect(
      describeProfile({
        ...base,
        extension: { state: 'enabled', source: 'Preferences', location: 4, path: '/d', disableReasons: [] },
      }),
    ).toBe('Default [Personal]  enabled (unpacked) <- /d');
    expect(
      describeProfile({
        ...base,
        extension: { state: 'absent', source: null, location: null, path: null, disableReasons: [] },
      }),
    ).toBe('Default [Personal]  not installed');
  });
});
