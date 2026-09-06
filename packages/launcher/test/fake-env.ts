import type { HostEnv, Platform } from '../src/env.js';

export interface FakeEnvOptions {
  platform: Platform;
  home: string;
  vars?: Record<string, string | undefined>;
  /** Absolute path -> file contents. Parent directories are implied. */
  files?: Record<string, string>;
  /** Extra directories that exist but hold no files we care about. */
  dirs?: string[];
  /** `${file} ${args.join(' ')}` -> stdout. */
  commands?: Record<string, string>;
}

/**
 * An in-memory HostEnv. Path separators are normalised to "/" internally so a
 * Windows-shaped fixture can be written with backslashes and still resolve.
 */
export function fakeEnv(opts: FakeEnvOptions): HostEnv {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const files = new Map(Object.entries(opts.files ?? {}).map(([k, v]) => [norm(k), v]));
  const dirs = new Set<string>(opts.dirs?.map(norm) ?? []);
  for (const path of files.keys()) {
    let parent = path.slice(0, path.lastIndexOf('/'));
    while (parent.length > 0) {
      dirs.add(parent);
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }
  const commands = opts.commands ?? {};

  return {
    platform: opts.platform,
    home: opts.home,
    vars: opts.vars ?? {},
    exists: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    readFile: (p) => {
      const content = files.get(norm(p));
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    readDir: (p) => {
      const dir = norm(p);
      if (!dirs.has(dir)) throw new Error(`ENOENT: ${p}`);
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const entry of [...files.keys(), ...dirs]) {
        if (!entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        const head = rest.split('/')[0];
        if (head) names.add(head);
      }
      return [...names];
    },
    exec: (file, args) => commands[`${file} ${args.join(' ')}`] ?? null,
  };
}

/** Build a Chromium Preferences blob registering one extension id. */
export function prefsWithExtension(
  extensionId: string,
  record: Record<string, unknown> = { location: 4, path: '/dist' },
): string {
  return JSON.stringify({ extensions: { settings: { [extensionId]: record } } });
}

/** Build a Local State blob with the given profile dir -> display name map. */
export function localState(names: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const info_cache = Object.fromEntries(Object.entries(names).map(([dir, name]) => [dir, { name }]));
  return JSON.stringify({ profile: { info_cache, ...extra } });
}
