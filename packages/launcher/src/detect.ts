import type { HostEnv, Platform } from './env.js';
import { nodeEnv, safeExists, safeReadDir } from './env.js';
import { joinPath, samePath } from './pathutil.js';
import type { BrowserFamily, BrowserInstall } from './types.js';

interface Candidate {
  family: BrowserFamily;
  name: string;
  /** Absolute paths to probe, in preference order. */
  paths: string[];
  /** Bare command names to resolve through PATH (posix only). */
  commands?: string[];
  /** Stock user data dir for this browser on this platform. */
  userDataDir: string;
}

/** macOS app-bundle candidates; both /Applications and ~/Applications. */
function macCandidates(env: HostEnv): Candidate[] {
  const appDirs = ['/Applications', joinPath('darwin', env.home, 'Applications')];
  const support = joinPath('darwin', env.home, 'Library', 'Application Support');
  const bundle = (app: string, bin: string): string[] =>
    appDirs.map((d) => joinPath('darwin', d, `${app}.app`, 'Contents', 'MacOS', bin));
  return [
    {
      family: 'chrome',
      name: 'Google Chrome',
      paths: bundle('Google Chrome', 'Google Chrome'),
      userDataDir: joinPath('darwin', support, 'Google', 'Chrome'),
    },
    {
      family: 'edge',
      name: 'Microsoft Edge',
      paths: bundle('Microsoft Edge', 'Microsoft Edge'),
      userDataDir: joinPath('darwin', support, 'Microsoft Edge'),
    },
    {
      family: 'brave',
      name: 'Brave Browser',
      paths: bundle('Brave Browser', 'Brave Browser'),
      userDataDir: joinPath('darwin', support, 'BraveSoftware', 'Brave-Browser'),
    },
    {
      family: 'chromium',
      name: 'Chromium',
      paths: bundle('Chromium', 'Chromium'),
      userDataDir: joinPath('darwin', support, 'Chromium'),
    },
  ];
}

/** Windows candidates from the three standard install roots. */
function winCandidates(env: HostEnv): Candidate[] {
  const roots = [
    env.vars['PROGRAMFILES'],
    env.vars['ProgramW6432'],
    env.vars['PROGRAMFILES(X86)'],
    env.vars['LOCALAPPDATA'],
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  const local = env.vars['LOCALAPPDATA'] ?? joinPath('win32', env.home, 'AppData', 'Local');
  const under = (...tail: string[]): string[] => roots.map((r) => joinPath('win32', r, ...tail));
  return [
    {
      family: 'chrome',
      name: 'Google Chrome',
      paths: under('Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: joinPath('win32', local, 'Google', 'Chrome', 'User Data'),
    },
    {
      family: 'edge',
      name: 'Microsoft Edge',
      paths: under('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      userDataDir: joinPath('win32', local, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      family: 'brave',
      name: 'Brave Browser',
      paths: under('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      userDataDir: joinPath('win32', local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    },
    {
      family: 'chromium',
      name: 'Chromium',
      paths: under('Chromium', 'Application', 'chrome.exe'),
      userDataDir: joinPath('win32', local, 'Chromium', 'User Data'),
    },
  ];
}

/** Linux candidates: PATH names first, then the usual /opt install roots. */
function linuxCandidates(env: HostEnv): Candidate[] {
  const cfg = joinPath('linux', env.home, '.config');
  return [
    {
      family: 'chrome',
      name: 'Google Chrome',
      commands: ['google-chrome', 'google-chrome-stable'],
      paths: ['/opt/google/chrome/google-chrome', '/opt/google/chrome/chrome'],
      userDataDir: joinPath('linux', cfg, 'google-chrome'),
    },
    {
      family: 'edge',
      name: 'Microsoft Edge',
      commands: ['microsoft-edge', 'microsoft-edge-stable'],
      paths: ['/opt/microsoft/msedge/msedge'],
      userDataDir: joinPath('linux', cfg, 'microsoft-edge'),
    },
    {
      family: 'brave',
      name: 'Brave Browser',
      commands: ['brave-browser', 'brave-browser-stable', 'brave'],
      paths: ['/opt/brave.com/brave/brave-browser'],
      userDataDir: joinPath('linux', cfg, 'BraveSoftware', 'Brave-Browser'),
    },
    {
      family: 'chromium',
      name: 'Chromium',
      commands: ['chromium', 'chromium-browser'],
      paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
      userDataDir: joinPath('linux', cfg, 'chromium'),
    },
  ];
}

/** The per-platform candidate table. Exported for tests and for launch flags. */
export function candidatesFor(env: HostEnv): Candidate[] {
  if (env.platform === 'darwin') return macCandidates(env);
  if (env.platform === 'win32') return winCandidates(env);
  return linuxCandidates(env);
}

/** Resolve a bare command name against PATH without shelling out. */
export function whichIn(env: HostEnv, command: string): string | null {
  const rawPath = env.vars['PATH'] ?? '';
  const sep = env.platform === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(sep)) {
    if (dir.length === 0) continue;
    const full = joinPath(env.platform, dir, command);
    if (safeExists(env, full)) return full;
  }
  return null;
}

/**
 * Read a browser's version. `--version` works everywhere except Windows, where
 * chrome.exe writes nothing to stdout — there the versioned subdirectory next
 * to the binary (Application\151.0.7922.169\) is the reliable source.
 */
export function readVersion(env: HostEnv, exe: string, platform: Platform = env.platform): string | null {
  if (platform === 'win32') {
    const appDir = exe.slice(0, Math.max(exe.lastIndexOf('\\'), exe.lastIndexOf('/')));
    const versioned = safeReadDir(env, appDir).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    versioned.sort(compareVersion);
    return versioned.at(-1) ?? null;
  }
  const out = env.exec(exe, ['--version']);
  if (!out) return null;
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Numeric-segment version compare, so "9.0.0.0" sorts below "151.0.0.0". */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Extract the dotted version out of "Google Chrome 151.0.7922.169". */
export function parseVersionNumber(version: string | null): string | null {
  if (!version) return null;
  return /(\d+\.\d+\.\d+\.\d+)/.exec(version)?.[1] ?? null;
}

/** Major version as a number, for the Chrome >= 137 feature gates. */
export function majorVersion(version: string | null): number | null {
  const num = parseVersionNumber(version);
  if (!num) return null;
  const major = Number(num.split('.')[0]);
  return Number.isFinite(major) ? major : null;
}

export interface DetectOptions {
  /** Skip `<exe> --version` (each call spawns a process). */
  skipVersion?: boolean;
  /**
   * Extra user data dirs to attribute to a detected browser, keyed by family —
   * used for people who run Chrome with a non-stock `--user-data-dir`.
   */
  extraUserDataDirs?: Partial<Record<BrowserFamily, string[]>>;
}

/**
 * Find every Chromium-family browser installed on this machine.
 *
 * One entry per (browser, user data dir): a browser run with a custom
 * `--user-data-dir` yields a second entry for the same executable, because the
 * extension lives in a user data dir, not in the binary.
 */
export function detectBrowsers(env: HostEnv = nodeEnv(), opts: DetectOptions = {}): BrowserInstall[] {
  const found: BrowserInstall[] = [];
  for (const candidate of candidatesFor(env)) {
    const exe = resolveExecutable(env, candidate);
    if (!exe) continue;
    const version = opts.skipVersion ? null : readVersion(env, exe);
    const dirs = [candidate.userDataDir, ...(opts.extraUserDataDirs?.[candidate.family] ?? [])];
    const seen = new Set<string>();
    for (const dir of dirs) {
      const key = env.platform === 'linux' ? dir : dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // A stock dir that does not exist yet is still worth reporting (the
      // browser is installed, just never run); a custom dir is only real if
      // it is on disk.
      const isStock = samePath(env.platform, dir, candidate.userDataDir);
      if (!isStock && !safeExists(env, dir)) continue;
      found.push({
        name: candidate.name,
        family: candidate.family,
        executablePath: exe,
        userDataDir: dir,
        version,
        isDefaultUserDataDir: isStock,
      });
    }
  }
  return found;
}

function resolveExecutable(env: HostEnv, candidate: Candidate): string | null {
  for (const command of candidate.commands ?? []) {
    const resolved = whichIn(env, command);
    if (resolved) return resolved;
  }
  for (const path of candidate.paths) {
    if (safeExists(env, path)) return path;
  }
  return null;
}
