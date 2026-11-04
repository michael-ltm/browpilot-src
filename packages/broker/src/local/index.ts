import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { LocalBrowserFamily, LocalBrowserProfile } from '@browpilot/shared';
import { graphicalEnv } from '@browpilot/shared/node';

type Registration = Pick<LocalBrowserProfile, 'browser' | 'executable' | 'userDataDir'> & Partial<Pick<LocalBrowserProfile, 'profileDirectory' | 'label'>>;
type Root = { browser: LocalBrowserFamily; executable: string; userDataDir: string };
type Options = {
  configDir: string;
  extensionIds: string[];
  connectedIds: () => string[];
  storeUrls?: Partial<Record<LocalBrowserFamily, string>>;
  launch?: (executable: string, args: string[]) => void | Promise<void>;
  platform?: NodeJS.Platform;
  roots?: Root[];
  now?: () => number;
};
type Catalog = { profiles: Registration[]; bindings: Record<string, string>; aliases: Record<string, string> };

// Moved to @browpilot/shared/node so the MCP server's developer launch can share it.
export { graphicalEnv };

const defaultLaunch = (executable: string, args: string[]) => new Promise<void>((resolveLaunch, rejectLaunch) => {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env: graphicalEnv(process.env) });
  child.once('error', rejectLaunch);
  child.once('spawn', () => { child.unref(); resolveLaunch(); });
});
const idFor = (p: Registration) => 'local-' + createHash('sha256').update([p.browser, resolve(p.executable), resolve(p.userDataDir), p.profileDirectory ?? 'Default'].join('\0')).digest('hex').slice(0, 20);
const validDirectory = (s: string) => s.length > 0 && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0');
const exists = async (p: string) => access(p).then(() => true, () => false);

export function localBrowserCandidates(platform: NodeJS.Platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): Root[] {
  if (platform === 'darwin') return [
    { browser: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', userDataDir: join(home, 'Library/Application Support/Google/Chrome') },
    { browser: 'chrome', executable: join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), userDataDir: join(home, 'Library/Application Support/Google/Chrome') },
    { browser: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', userDataDir: join(home, 'Library/Application Support/Microsoft Edge') },
    { browser: 'edge', executable: join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), userDataDir: join(home, 'Library/Application Support/Microsoft Edge') },
    { browser: 'chromium', executable: '/Applications/Chromium.app/Contents/MacOS/Chromium', userDataDir: join(home, 'Library/Application Support/Chromium') },
    { browser: 'chromium', executable: join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'), userDataDir: join(home, 'Library/Application Support/Chromium') },
  ];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData/Local');
    const program = env.PROGRAMFILES ?? 'C:\\Program Files';
    const programX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      { browser: 'chrome', executable: join(program, 'Google/Chrome/Application/chrome.exe'), userDataDir: join(local, 'Google/Chrome/User Data') },
      { browser: 'chrome', executable: join(local, 'Google/Chrome/Application/chrome.exe'), userDataDir: join(local, 'Google/Chrome/User Data') },
      { browser: 'chrome', executable: join(programX86, 'Google/Chrome/Application/chrome.exe'), userDataDir: join(local, 'Google/Chrome/User Data') },
      { browser: 'edge', executable: join(programX86, 'Microsoft/Edge/Application/msedge.exe'), userDataDir: join(local, 'Microsoft/Edge/User Data') },
      { browser: 'edge', executable: join(local, 'Microsoft/Edge/Application/msedge.exe'), userDataDir: join(local, 'Microsoft/Edge/User Data') },
      { browser: 'chromium', executable: join(program, 'Chromium/Application/chrome.exe'), userDataDir: join(local, 'Chromium/User Data') },
    ];
  }
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'chromium', 'chromium-browser'].map(name => ({
    browser: name.startsWith('google') ? 'chrome' : name.startsWith('microsoft') ? 'edge' : 'chromium',
    executable: '/usr/bin/' + name,
    userDataDir: join(config, name.startsWith('google') ? 'google-chrome' : name.startsWith('microsoft') ? 'microsoft-edge' : 'chromium'),
  }));
}

export class LocalBrowserManager {
  private catalog?: Catalog;
  private loading?: Promise<Catalog>;
  private writes: Promise<void> = Promise.resolve();
  private cached: LocalBrowserProfile[] = [];
  private pending = new Map<string, Promise<{ browserId: string; profile: LocalBrowserProfile; launched: boolean }>>();
  private nonces = new Map<string, { id: string; expires: number; resolve: (browserId: string) => void; reject: (error: Error) => void; consuming?: boolean }>();
  constructor(private readonly options: Options) {}

  private get file() { return join(this.options.configDir, 'browser-profiles.json'); }
  private async load() {
    if (this.catalog) return this.catalog;
    if (this.loading) return this.loading;
    this.loading = (async () => { try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as Catalog;
      this.catalog = { profiles: Array.isArray(data.profiles) ? data.profiles.filter((p): p is Registration => !!p && typeof p === 'object' && ['chrome', 'edge', 'chromium'].includes(p.browser) && typeof p.executable === 'string' && typeof p.userDataDir === 'string' && (p.profileDirectory === undefined || typeof p.profileDirectory === 'string')) : [], bindings: data.bindings && typeof data.bindings === 'object' ? data.bindings : {}, aliases: data.aliases && typeof data.aliases === 'object' ? data.aliases : {} };
    } catch { this.catalog = { profiles: [], bindings: {}, aliases: {} }; }
    return this.catalog; })();
    return this.loading;
  }
  private async save(snapshot: Catalog) {
    await mkdir(this.options.configDir, { recursive: true });
    const temp = this.file + '.' + randomBytes(6).toString('hex') + '.tmp';
    await writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
  private transaction<T>(job: (catalog: Catalog) => Promise<T>): Promise<T> {
    const work = this.writes.then(async () => job(await this.load()));
    this.writes = work.then(() => undefined, () => undefined);
    return work;
  }
  private async canonical(p: Registration): Promise<Registration> {
    const userDataDir = await realpath(p.userDataDir);
    const profilePath = await realpath(join(userDataDir, p.profileDirectory ?? 'Default'));
    if (!profilePath.startsWith(userDataDir + sep)) throw new Error('Profile directory resolves outside user-data directory');
    return { ...p, executable: await realpath(p.executable), userDataDir };
  }
  private async profilesFor(root: Root): Promise<Registration[]> {
    if (!(await exists(root.executable)) || !(await exists(root.userDataDir))) return [];
    const names = new Set<string>();
    const labels = new Map<string, string>();
    try {
      const state = JSON.parse(await readFile(join(root.userDataDir, 'Local State'), 'utf8'));
      for (const [name, info] of Object.entries(state?.profile?.info_cache ?? {})) if (validDirectory(name)) {
        names.add(name);
        const display = (info as { name?: unknown })?.name;
        if (typeof display === 'string' && display.trim()) labels.set(name, display.trim());
      }
    } catch { /* A locked or malformed Local State does not prevent directory discovery. */ }
    try {
      for (const entry of await readdir(root.userDataDir, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name))) names.add(entry.name);
      }
    } catch { /* Ignore unreadable roots. */ }
    const result: Registration[] = [];
    for (const profileDirectory of names) if (await exists(join(root.userDataDir, profileDirectory))) result.push({ ...root, profileDirectory, label: labels.get(profileDirectory) });
    return result;
  }
  private async extensionFor(p: Registration): Promise<LocalBrowserProfile['extension']> {
    const dir = join(p.userDataDir, p.profileDirectory ?? 'Default');
    const ids = this.options.extensionIds;
    let completeEvidence = true;
    const states = new Map<string, LocalBrowserProfile['extension']>();
    for (const name of ['Preferences', 'Secure Preferences']) {
      try {
        const prefs = JSON.parse(await readFile(join(dir, name), 'utf8'));
        const settings = prefs?.extensions?.settings;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { completeEvidence = false; continue; }
        for (const id of ids) {
          const ext = settings[id];
          if (ext && typeof ext === 'object') states.set(id, { state: ext.state === 1 ? 'enabled' : ext.state === 0 ? 'disabled' : 'installed', id });
        }
      } catch { completeEvidence = false; }
    }
    for (const id of ids) if (states.get(id)?.state === 'enabled') return states.get(id)!;
    for (const id of ids) if (!states.has(id) && await exists(join(dir, 'Extensions', id))) states.set(id, { state: 'installed', id });
    for (const id of ids) if (states.get(id)?.state === 'installed') return states.get(id)!;
    for (const id of ids) if (states.get(id)?.state === 'disabled') return states.get(id)!;
    return { state: completeEvidence ? 'absent' : 'unknown' };
  }
  async list(): Promise<LocalBrowserProfile[]> {
    const catalog = await this.load();
    const discovered = (await Promise.all((this.options.roots ?? localBrowserCandidates(this.options.platform ?? process.platform)).map(r => this.profilesFor(r)))).flat();
    const all = new Map<string, Registration>();
    for (const raw of [...discovered, ...catalog.profiles]) if (validDirectory(raw.profileDirectory ?? 'Default')) {
      try {
        const p = await this.canonical(raw);
        const prior = all.get(idFor(p));
        all.set(idFor(p), { ...p, label: p.label ?? prior?.label });
      } catch { /* Stale or unsafe installation; ignore. */ }
    }
    const connected = new Set(this.options.connectedIds());
    this.cached = await Promise.all([...all].map(async ([id, p]) => {
      const browserId = catalog.bindings[id];
      return { ...p, id, profileDirectory: p.profileDirectory ?? 'Default', label: p.label ?? `${p.browser} ${p.profileDirectory ?? 'Default'}`, extension: await this.extensionFor(p), ...(browserId ? { browserId } : {}), connected: !!browserId && connected.has(browserId) };
    }));
    return this.cached;
  }
  async register(input: Registration): Promise<LocalBrowserProfile> {
    if (!['chrome', 'edge', 'chromium'].includes(input.browser) || !isAbsolute(input.executable) || !isAbsolute(input.userDataDir) || !validDirectory(input.profileDirectory ?? 'Default')) throw new Error('Invalid local browser path or profile directory');
    if (!(await exists(input.executable)) || !(await exists(join(input.userDataDir, input.profileDirectory ?? 'Default')))) throw new Error('Browser executable or profile directory does not exist');
    const p = { ...(await this.canonical(input)), profileDirectory: input.profileDirectory ?? 'Default' };
    await this.transaction(async catalog => {
      const next = { profiles: [...catalog.profiles.filter(x => idFor(x) !== idFor(p)), p], bindings: { ...catalog.bindings }, aliases: { ...catalog.aliases } };
      await this.save(next);
      this.catalog = next;
    });
    return (await this.list()).find(x => x.id === idFor(p))!;
  }
  canResolve(id: string): boolean { return this.cached.some(p => p.id === id || p.browserId === id || this.catalog?.aliases[id] === p.id); }
  private async resolveProfile(id: string) {
    const profiles = await this.list();
    const matches = profiles.filter(p => p.id === id || p.browserId === id || this.catalog?.aliases[id] === p.id);
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous local browser profile' : `Unknown local browser profile: ${id}`);
    return matches[0]!;
  }
  async ensure(id: string, timeoutMs = 15000): Promise<{ browserId: string; profile: LocalBrowserProfile; launched: boolean }> {
    const profile = await this.resolveProfile(id);
    const existing = this.pending.get(profile.id);
    if (existing) return existing;
    const work = this.ensureOne(profile, timeoutMs).finally(() => this.pending.delete(profile.id));
    this.pending.set(profile.id, work);
    return work;
  }
  private async ensureOne(profile: LocalBrowserProfile, timeoutMs: number) {
    if (profile.connected && profile.browserId) return { browserId: profile.browserId, profile, launched: false };
    if (!['enabled', 'installed'].includes(profile.extension.state) || !profile.extension.id) throw new Error(`Browpilot extension is ${profile.extension.state} in ${profile.label}`);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid local browser launch timeout');
    const nonce = randomBytes(24).toString('base64url');
    let done!: (id: string) => void;
    let failed!: (error: Error) => void;
    const paired = new Promise<string>((resolve, reject) => { done = resolve; failed = reject; });
    const expires = (this.options.now ?? Date.now)() + timeoutMs;
    this.nonces.set(nonce, { id: profile.id, expires, resolve: done, reject: failed });
    const args = [`--user-data-dir=${profile.userDataDir}`, `--profile-directory=${profile.profileDirectory}`, `chrome-extension://${profile.extension.id}/pair.html#${nonce}`];
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${profile.label} to connect`)), timeoutMs); });
    try {
      const browserId = await Promise.race([Promise.resolve().then(() => (this.options.launch ?? defaultLaunch)(profile.executable, args)).then(() => paired), deadline]);
      return { browserId, profile: (await this.resolveProfile(profile.id)), launched: true };
    } finally { clearTimeout(timer); this.nonces.delete(nonce); }
  }
  async pair(nonce: string, browserId: string): Promise<boolean> {
    const pending = this.nonces.get(nonce);
    if (!pending || pending.consuming || pending.expires <= (this.options.now ?? Date.now)() || !this.options.connectedIds().includes(browserId)) return false;
    pending.consuming = true;
    try {
      await this.transaction(async catalog => {
        if (this.nonces.get(nonce) !== pending || pending.expires <= (this.options.now ?? Date.now)()) throw new Error('Local browser pairing expired');
        if (Object.entries(catalog.bindings).some(([localId, runtime]) => localId !== pending.id && runtime === browserId) || (catalog.aliases[browserId] && catalog.aliases[browserId] !== pending.id)) {
          throw new Error('Browser identity already belongs to another local profile; reset identity and reload the copied profile');
        }
        const previous = catalog.bindings[pending.id];
        const aliases = { ...catalog.aliases };
        if (previous && previous !== browserId) aliases[previous] = pending.id;
        delete aliases[browserId];
        const next = { profiles: [...catalog.profiles], bindings: { ...catalog.bindings, [pending.id]: browserId }, aliases };
        await this.save(next);
        this.catalog = next;
      });
      this.nonces.delete(nonce);
      pending.resolve(browserId);
      return true;
    } catch (error) {
      this.nonces.delete(nonce);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
  async openInstall(id: string): Promise<{ profile: LocalBrowserProfile; url: string | null; instructions: string }> {
    const profile = await this.resolveProfile(id);
    const url = this.options.storeUrls?.[profile.browser] ?? null;
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('Browser store URL must use HTTPS'); }
      if (parsed.protocol !== 'https:' || !parsed.hostname) throw new Error('Browser store URL must use HTTPS');
    }
    const page = url ?? (profile.browser === 'edge' ? 'edge://extensions' : 'chrome://extensions');
    await (this.options.launch ?? defaultLaunch)(profile.executable, [`--user-data-dir=${profile.userDataDir}`, `--profile-directory=${profile.profileDirectory}`, page]);
    return { profile, url, instructions: url ? 'Review the store listing and confirm installation in the browser.' : `Open ${page}, enable Developer mode, then choose Load unpacked and select the Browpilot extension directory.` };
  }
}
