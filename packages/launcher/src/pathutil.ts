import type { Platform } from './env.js';

/**
 * Join path segments with the *target* platform's separator rather than the
 * host's. Detection is unit-tested cross-platform (a Linux CI box asserting
 * Windows paths), so node:path/join — which is fixed to the host — cannot be
 * used here.
 */
export function joinPath(platform: Platform, ...parts: string[]): string {
  const sep = platform === 'win32' ? '\\' : '/';
  const present = parts.filter((p) => p.length > 0);
  const [head, ...rest] = present;
  if (head === undefined) return '';
  const tail = rest.map((p) => trim(p, sep)).filter((p) => p.length > 0);
  // A lone separator is the posix root: it already supplies the joining sep.
  if (head === sep) return sep + tail.join(sep);
  return [stripTrailing(head, sep), ...tail].join(sep);
}

function stripTrailing(s: string, sep: string): string {
  // Keep "C:\" and other roots intact.
  return s.length > 1 && s.endsWith(sep) ? s.slice(0, -1) : s;
}

function trim(s: string, sep: string): string {
  let out = s;
  while (out.startsWith(sep)) out = out.slice(1);
  while (out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

/** Case-insensitive path comparison on Windows/macOS, exact on Linux. */
export function samePath(platform: Platform, a: string, b: string): boolean {
  const norm = (p: string): string => {
    const unified = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return platform === 'linux' ? unified : unified.toLowerCase();
  };
  return norm(a) === norm(b);
}
