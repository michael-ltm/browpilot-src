import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform as osPlatform } from 'node:os';

/** The three OS families we branch on. */
export type Platform = 'darwin' | 'win32' | 'linux';

/**
 * Everything the detectors touch outside their own arguments. Injected so the
 * whole detection layer stays pure and unit-testable on any host OS.
 */
export interface HostEnv {
  platform: Platform;
  home: string;
  /** process.env, or a fake with only the vars a test cares about. */
  vars: Record<string, string | undefined>;
  exists(path: string): boolean;
  readFile(path: string): string;
  readDir(path: string): string[];
  /** Run a command and return stdout; must return null instead of throwing. */
  exec(file: string, args: string[]): string | null;
}

/** Narrow the raw os.platform() string, defaulting the BSDs etc. to linux. */
export function normalizePlatform(p: string): Platform {
  if (p === 'darwin') return 'darwin';
  if (p === 'win32') return 'win32';
  return 'linux';
}

/** The real host: node fs + child_process. */
export function nodeEnv(overrides: Partial<HostEnv> = {}): HostEnv {
  return {
    platform: normalizePlatform(osPlatform()),
    home: homedir(),
    vars: process.env,
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    readDir: (p) => readdirSync(p),
    exec: (file, args) => {
      try {
        return execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    },
    ...overrides,
  };
}

/** exists() that never throws, for probing paths we may not be allowed to stat. */
export function safeExists(env: HostEnv, path: string): boolean {
  try {
    return env.exists(path);
  } catch {
    return false;
  }
}

/** readDir() that yields [] instead of throwing on a missing or unreadable dir. */
export function safeReadDir(env: HostEnv, path: string): string[] {
  try {
    return env.readDir(path);
  } catch {
    return [];
  }
}

/** Parse JSON, returning null on any read or parse failure. */
export function readJson<T = unknown>(env: HostEnv, path: string): T | null {
  try {
    return JSON.parse(env.readFile(path)) as T;
  } catch {
    return null;
  }
}
