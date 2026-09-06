import { describe, it, expect } from 'vitest';
import { fakeEnv } from './fake-env.js';
import {
  detectBrowsers,
  majorVersion,
  parseVersionNumber,
  readVersion,
  whichIn,
} from '../src/detect.js';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIN_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

describe('detectBrowsers on macOS', () => {
  it('finds Chrome and Edge with their stock user data dirs', () => {
    const env = fakeEnv({
      platform: 'darwin',
      home: '/Users/ada',
      files: {
        [MAC_CHROME]: '',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge': '',
      },
      commands: {
        [`${MAC_CHROME} --version`]: 'Google Chrome 151.0.7922.169\n',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --version': 'Microsoft Edge 140.0.1\n',
      },
    });
    const found = detectBrowsers(env);
    expect(found.map((b) => b.family)).toEqual(['chrome', 'edge']);
    expect(found[0]).toMatchObject({
      name: 'Google Chrome',
      executablePath: MAC_CHROME,
      userDataDir: '/Users/ada/Library/Application Support/Google/Chrome',
      version: 'Google Chrome 151.0.7922.169',
      isDefaultUserDataDir: true,
    });
    expect(found[1]?.userDataDir).toBe('/Users/ada/Library/Application Support/Microsoft Edge');
  });

  it('prefers /Applications over ~/Applications', () => {
    const env = fakeEnv({
      platform: 'darwin',
      home: '/Users/ada',
      files: {
        [MAC_CHROME]: '',
        '/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '',
      },
    });
    expect(detectBrowsers(env, { skipVersion: true })[0]?.executablePath).toBe(MAC_CHROME);
  });

  it('reports nothing when no browser is installed', () => {
    const env = fakeEnv({ platform: 'darwin', home: '/Users/ada' });
    expect(detectBrowsers(env, { skipVersion: true })).toEqual([]);
  });
});

describe('detectBrowsers on Windows', () => {
  it('builds install and user data paths from the environment', () => {
    const env = fakeEnv({
      platform: 'win32',
      home: 'C:\\Users\\ada',
      vars: {
        PROGRAMFILES: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
      },
      files: { [WIN_CHROME]: '' },
      dirs: ['C:\\Program Files\\Google\\Chrome\\Application\\151.0.7922.169'],
    });
    const [chrome] = detectBrowsers(env);
    expect(chrome).toMatchObject({
      family: 'chrome',
      executablePath: WIN_CHROME,
      userDataDir: 'C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\User Data',
      // Windows chrome.exe prints nothing for --version; the versioned
      // subdirectory next to the binary is the reliable source.
      version: '151.0.7922.169',
    });
  });

  it('picks the highest versioned directory, not the lexically largest', () => {
    const env = fakeEnv({
      platform: 'win32',
      home: 'C:\\Users\\ada',
      vars: { PROGRAMFILES: 'C:\\Program Files' },
      files: { [WIN_CHROME]: '' },
      dirs: [
        'C:\\Program Files\\Google\\Chrome\\Application\\99.0.1.0',
        'C:\\Program Files\\Google\\Chrome\\Application\\151.0.7922.169',
      ],
    });
    expect(readVersion(env, WIN_CHROME)).toBe('151.0.7922.169');
  });
});

describe('detectBrowsers on Linux', () => {
  it('resolves binaries through PATH', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/usr/local/bin:/usr/bin' },
      files: { '/usr/bin/google-chrome': '' },
      commands: { '/usr/bin/google-chrome --version': 'Google Chrome 151.0.7922.169\n' },
    });
    const [chrome] = detectBrowsers(env);
    expect(chrome).toMatchObject({
      executablePath: '/usr/bin/google-chrome',
      userDataDir: '/home/ada/.config/google-chrome',
      isDefaultUserDataDir: true,
    });
  });

  it('falls back to the /opt install path when PATH has no entry', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/usr/bin' },
      files: { '/opt/google/chrome/google-chrome': '' },
    });
    expect(detectBrowsers(env, { skipVersion: true })[0]?.executablePath).toBe('/opt/google/chrome/google-chrome');
  });

  it('adds a second entry for a custom user data dir that exists', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/usr/bin' },
      files: { '/usr/bin/google-chrome': '', '/home/ada/work-profile/Local State': '{}' },
    });
    const found = detectBrowsers(env, {
      skipVersion: true,
      extraUserDataDirs: { chrome: ['/home/ada/work-profile'] },
    });
    expect(found.map((b) => [b.userDataDir, b.isDefaultUserDataDir])).toEqual([
      ['/home/ada/.config/google-chrome', true],
      ['/home/ada/work-profile', false],
    ]);
  });

  it('ignores a custom user data dir that is not on disk', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/usr/bin' },
      files: { '/usr/bin/google-chrome': '' },
    });
    const found = detectBrowsers(env, { skipVersion: true, extraUserDataDirs: { chrome: ['/nope'] } });
    expect(found).toHaveLength(1);
  });

  it('does not duplicate a custom dir that is also the stock dir', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/usr/bin' },
      files: { '/usr/bin/google-chrome': '', '/home/ada/.config/google-chrome/Local State': '{}' },
    });
    const found = detectBrowsers(env, {
      skipVersion: true,
      extraUserDataDirs: { chrome: ['/home/ada/.config/google-chrome'] },
    });
    expect(found).toHaveLength(1);
  });
});

describe('whichIn', () => {
  it('returns the first PATH hit and null when there is none', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      vars: { PATH: '/a:/b' },
      files: { '/b/chromium': '' },
    });
    expect(whichIn(env, 'chromium')).toBe('/b/chromium');
    expect(whichIn(env, 'brave-browser')).toBeNull();
  });
});

describe('version parsing', () => {
  it('extracts the dotted number and the major', () => {
    expect(parseVersionNumber('Google Chrome 151.0.7922.169')).toBe('151.0.7922.169');
    expect(majorVersion('Google Chrome 151.0.7922.169')).toBe(151);
    expect(majorVersion('Chromium unknown')).toBeNull();
    expect(majorVersion(null)).toBeNull();
  });
});
