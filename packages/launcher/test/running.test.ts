import { describe, it, expect } from 'vitest';
import { fakeEnv } from './fake-env.js';
import {
  listRunningBrowsers,
  parsePsOutput,
  executableOf,
  parseUserDataDir,
  parseWmicOutput,
  processesForUserDataDir,
  runningUserDataDirs,
} from '../src/running.js';

// Trimmed from real `ps -eo pid=,args=` output on a machine running Chrome with
// a custom profile dir: the browser, its crash handler, a renderer child, and
// the logging wrapper that launched it (whose command line names Chrome twice).
const PS_OUTPUT = [
  ' 156959 /opt/google/chrome/chrome --no-sandbox --password-store=basic --user-data-dir=/home/box/chrome-profile-3 --remote-debugging-port=9225',
  ' 156964 bash /usr/local/bin/box-bounded-log --run /tmp/chrome:3.log -- env DISPLAY=:3 google-chrome-stable --user-data-dir=/home/box/chrome-profile-3',
  ' 156965 flock -n /tmp/chrome:3.log.lock /exec-daemon/node /usr/local/bin/box-bounded-log.mjs /tmp/chrome:3.log 156959',
  ' 156967 /exec-daemon/node /usr/local/bin/box-bounded-log.mjs /tmp/chrome:3.log 156959',
  ' 156985 /opt/google/chrome/chrome_crashpad_handler --monitor-self --database=/home/box/.config/google-chrome/Crash Reports',
  ' 157102 /opt/google/chrome/chrome --type=renderer --user-data-dir=/home/box/chrome-profile-3 --lang=en-US',
  ' 158000 /usr/bin/microsoft-edge-stable',
  ' 158100 /usr/bin/node /some/other/process.js',
  '',
].join('\n');

describe('parsePsOutput', () => {
  it('keeps browser processes and drops children, helpers and wrappers', () => {
    const procs = parsePsOutput(PS_OUTPUT);
    expect(procs.map((p) => p.pid)).toEqual([156959, 158000]);
  });

  it('extracts the custom user data dir and leaves a stock launch null', () => {
    const [chrome, edge] = parsePsOutput(PS_OUTPUT);
    expect(chrome).toMatchObject({ family: 'chrome', userDataDir: '/home/box/chrome-profile-3' });
    expect(edge).toMatchObject({ family: 'edge', userDataDir: null });
  });
});

describe('executableOf', () => {
  it('keeps spaces inside a browser path and stops at the first flag', () => {
    expect(executableOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/x')).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(executableOf('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-sandbox')).toBe(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    );
  });
});

describe('family matching', () => {
  it('recognises the macOS bundle binary but not its Helper', () => {
    const procs = parsePsOutput(
      [
        ' 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ' 2 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
        ' 3 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ].join('\n'),
    );
    expect(procs.map((p) => [p.pid, p.family])).toEqual([
      [1, 'chrome'],
      [3, 'brave'],
    ]);
  });
});

describe('parseUserDataDir', () => {
  it('handles =, space, and quoted forms', () => {
    expect(parseUserDataDir('chrome --user-data-dir=/a/b --x')).toBe('/a/b');
    expect(parseUserDataDir('chrome --user-data-dir "C:\\Users\\ada\\My Data" --x')).toBe('C:\\Users\\ada\\My Data');
    expect(parseUserDataDir('chrome --user-data-dir="C:\\Users\\ada\\My Data"')).toBe('C:\\Users\\ada\\My Data');
    expect(parseUserDataDir("chrome --user-data-dir='/a b/c'")).toBe('/a b/c');
    expect(parseUserDataDir('chrome --no-sandbox')).toBeNull();
  });
});

describe('parseWmicOutput', () => {
  it('reads pid and command line out of the CSV, commas and all', () => {
    const csv = [
      'Node,CommandLine,ProcessId',
      'HOST,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\ada\\Data,x",4321',
      'HOST,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer,4322',
      '',
    ].join('\n');
    const procs = parseWmicOutput(csv);
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pid: 4321, family: 'chrome', userDataDir: 'C:\\Users\\ada\\Data,x' });
  });
});

describe('listRunningBrowsers', () => {
  it('shells out to ps on posix and returns [] when the command fails', () => {
    const env = fakeEnv({
      platform: 'linux',
      home: '/home/ada',
      commands: { 'ps -eo pid=,args=': PS_OUTPUT },
    });
    expect(listRunningBrowsers(env).map((p) => p.pid)).toEqual([156959, 158000]);
    const bare = fakeEnv({ platform: 'linux', home: '/home/ada' });
    expect(listRunningBrowsers(bare)).toEqual([]);
  });
});

describe('runningUserDataDirs', () => {
  it('groups the custom dirs by family, de-duplicated', () => {
    const env = fakeEnv({ platform: 'linux', home: '/home/ada' });
    const procs = parsePsOutput(`${PS_OUTPUT}\n 159000 /opt/google/chrome/chrome --user-data-dir=/home/box/chrome-profile-3`);
    expect(runningUserDataDirs(env, procs)).toEqual({ chrome: ['/home/box/chrome-profile-3'] });
  });
});

describe('processesForUserDataDir', () => {
  const env = fakeEnv({ platform: 'linux', home: '/home/ada' });
  const procs = parsePsOutput(PS_OUTPUT);

  it('matches an explicit --user-data-dir', () => {
    const hits = processesForUserDataDir(
      { family: 'chrome', userDataDir: '/home/box/chrome-profile-3', isDefaultUserDataDir: false },
      env,
      procs,
    );
    expect(hits.map((p) => p.pid)).toEqual([156959]);
  });

  it('attributes a flagless process to its family stock dir', () => {
    const hits = processesForUserDataDir(
      { family: 'edge', userDataDir: '/home/ada/.config/microsoft-edge', isDefaultUserDataDir: true },
      env,
      procs,
    );
    expect(hits.map((p) => p.pid)).toEqual([158000]);
  });

  it('reports an idle user data dir as having no processes', () => {
    const hits = processesForUserDataDir(
      { family: 'chrome', userDataDir: '/home/ada/.config/google-chrome', isDefaultUserDataDir: true },
      env,
      procs,
    );
    expect(hits).toEqual([]);
  });
});
