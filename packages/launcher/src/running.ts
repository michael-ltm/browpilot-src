import type { HostEnv } from './env.js';
import { nodeEnv } from './env.js';
import { samePath } from './pathutil.js';
import type { BrowserFamily } from './types.js';

/** One live browser process (the browser process, not a renderer child). */
export interface RunningBrowser {
  pid: number;
  family: BrowserFamily | null;
  /** Value of --user-data-dir, or null when the browser uses its stock dir. */
  userDataDir: string | null;
  commandLine: string;
}

/**
 * Binary names that identify a browser process by family, anchored at the end
 * of the executable path. Anchoring matters: a wrapper script or a log file
 * named after Chrome mentions "chrome" in its command line without being a
 * browser, and so do the crashpad and helper binaries inside the install.
 */
const FAMILY_MARKERS: Array<[BrowserFamily, RegExp]> = [
  ['edge', /(?:msedge|microsoft[- ]?edge)(?:-(?:stable|beta|dev))?(?:\.exe)?$/i],
  ['brave', /brave(?:[- ]browser)?(?:-(?:stable|beta|dev))?(?:\.exe)?$/i],
  ['chrome', /(?:google[- ]?chrome|chrome)(?:-(?:stable|beta|dev))?(?:\.exe)?$/i],
  ['chromium', /chromium(?:[- ]browser)?(?:\.exe)?$/i],
];

/** Renderer/GPU/utility children all carry --type=; only the parent has none. */
function isBrowserProcess(commandLine: string): boolean {
  return !/--type=/.test(commandLine);
}

/**
 * The executable part of a command line: everything before the first flag,
 * unquoted. Browser paths contain spaces ("…/MacOS/Google Chrome"), so the
 * first flag — not the first space — is the only reliable delimiter.
 */
export function executableOf(commandLine: string): string {
  const flagAt = commandLine.search(/\s-/);
  const head = (flagAt === -1 ? commandLine : commandLine.slice(0, flagAt)).trim();
  return head.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function familyOf(commandLine: string): BrowserFamily | null {
  const exe = executableOf(commandLine);
  for (const [family, re] of FAMILY_MARKERS) {
    if (re.test(exe)) return family;
  }
  return null;
}

/**
 * Pull the --user-data-dir value out of a command line, handling both
 * `--user-data-dir=X` and `--user-data-dir X`, quoted or bare.
 */
export function parseUserDataDir(commandLine: string): string | null {
  const quoted = /--user-data-dir=(?:"([^"]*)"|'([^']*)')/.exec(commandLine);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  const eq = /--user-data-dir=(\S+)/.exec(commandLine);
  if (eq?.[1]) return eq[1];
  const spaced = /--user-data-dir\s+(?:"([^"]*)"|(\S+))/.exec(commandLine);
  return spaced?.[1] ?? spaced?.[2] ?? null;
}

/** Parse `ps -eo pid=,args=` output into browser processes. */
export function parsePsOutput(text: string): RunningBrowser[] {
  const out: RunningBrowser[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const commandLine = match[2];
    if (!isBrowserProcess(commandLine)) continue;
    const family = familyOf(commandLine);
    if (!family) continue;
    out.push({
      pid: Number(match[1]),
      family,
      userDataDir: parseUserDataDir(commandLine),
      commandLine,
    });
  }
  return out;
}

/**
 * Parse `wmic process get ProcessId,CommandLine /format:csv` output. The CSV is
 * Node,CommandLine,ProcessId with the command line itself possibly containing
 * commas, so take the first field as node and the last as pid.
 */
export function parseWmicOutput(text: string): RunningBrowser[] {
  const out: RunningBrowser[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('Node,')) continue;
    const first = trimmed.indexOf(',');
    const last = trimmed.lastIndexOf(',');
    if (first === -1 || last === first) continue;
    const commandLine = trimmed.slice(first + 1, last);
    const pid = Number(trimmed.slice(last + 1));
    if (!Number.isFinite(pid) || commandLine.length === 0) continue;
    if (!isBrowserProcess(commandLine)) continue;
    const family = familyOf(commandLine);
    if (!family) continue;
    out.push({ pid, family, userDataDir: parseUserDataDir(commandLine), commandLine });
  }
  return out;
}

/** Enumerate the browser processes currently running on this machine. */
export function listRunningBrowsers(env: HostEnv = nodeEnv()): RunningBrowser[] {
  if (env.platform === 'win32') {
    const out = env.exec('wmic', ['process', 'get', 'ProcessId,CommandLine', '/format:csv']);
    return out ? parseWmicOutput(out) : [];
  }
  const out = env.exec('ps', ['-eo', 'pid=,args=']);
  return out ? parsePsOutput(out) : [];
}

/**
 * Group the non-stock `--user-data-dir` values of running browsers by family,
 * so detection can report the profile dir a user actually browses in.
 */
export function runningUserDataDirs(
  env: HostEnv = nodeEnv(),
  running: RunningBrowser[] = listRunningBrowsers(env),
): Partial<Record<BrowserFamily, string[]>> {
  const byFamily: Partial<Record<BrowserFamily, string[]>> = {};
  for (const proc of running) {
    if (!proc.family || !proc.userDataDir) continue;
    const list = (byFamily[proc.family] ??= []);
    if (!list.some((d) => samePath(env.platform, d, proc.userDataDir as string))) {
      list.push(proc.userDataDir);
    }
  }
  return byFamily;
}

/**
 * The live processes using a given browser + user data dir (empty when idle).
 *
 * A browser started without `--user-data-dir` is using its stock dir, so a
 * process with no flag matches the stock-dir entry of its own family.
 */
export function processesForUserDataDir(
  target: { family: BrowserFamily; userDataDir: string; isDefaultUserDataDir: boolean },
  env: HostEnv = nodeEnv(),
  running: RunningBrowser[] = listRunningBrowsers(env),
): RunningBrowser[] {
  return running.filter((p) => {
    if (p.userDataDir === null) return target.isDefaultUserDataDir && p.family === target.family;
    return samePath(env.platform, p.userDataDir, target.userDataDir);
  });
}
