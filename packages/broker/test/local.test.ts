import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBrowserManager, localBrowserCandidates, graphicalEnv } from '../src/local/index.js';
import { RELEASED_CHROME_EXTENSION_ID, RELEASED_CHROME_STORE_URL, withReleaseDefaults } from '../src/release-config.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browpilot-local-'));
  const executable = join(root, 'chrome');
  const userDataDir = join(root, 'data');
  await writeFile(executable, '');
  await mkdir(join(userDataDir, 'Default'), { recursive: true });
  return { root, executable, userDataDir };
}

describe('local browser lifecycle', () => {
  it('finds the released Chrome extension and opens its configured store listing', async () => {
    const f = await fixture();
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [RELEASED_CHROME_EXTENSION_ID]: { state: 1 } } } }));
    const cfg = withReleaseDefaults({ port: 0, token: 'test', extensionId: 'unpacked-id' });
    const launch = vi.fn();
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [cfg.extensionId, ...(cfg.extensionIds ?? [])], storeUrls: cfg.storeUrls, connectedIds: () => [], roots: [], launch });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    expect(p.extension).toEqual({ state: 'enabled', id: RELEASED_CHROME_EXTENSION_ID });
    expect((await m.openInstall(p.id)).url).toBe(RELEASED_CHROME_STORE_URL);
    expect(launch).toHaveBeenCalledWith(f.executable, [`--user-data-dir=${f.userDataDir}`, '--profile-directory=Default', RELEASED_CHROME_STORE_URL]);
  });
  it('registers a stable custom profile and rejects traversal', async () => {
    const f = await fixture();
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: ['a'.repeat(32)], connectedIds: () => [], roots: [] });
    const a = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const b = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    expect(a.id).toBe(b.id);
    expect((await m.list()).map(p => p.id)).toContain(a.id);
    await expect(m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir, profileDirectory: '../evil' })).rejects.toThrow();
  });

  it('detects enabled extension from profile preferences', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1, path: 'x' } } } }));
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: [id], connectedIds: () => [], roots: [] });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    expect(p.extension).toEqual({ state: 'enabled', id });
  });

  it('waits for verified pairing and deduplicates concurrent launch', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    const connected = new Set<string>();
    let nonce = '';
    const launch = vi.fn((_exe: string, args: string[]) => { nonce = args.at(-1)!.split('#')[1]!; });
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: [id], connectedIds: () => [...connected], roots: [], launch });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const a = m.ensure(p.id, 500);
    const b = m.ensure(p.id, 500);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    connected.add('runtime');
    expect(await m.pair(nonce, 'runtime')).toBe(true);
    expect(await m.pair(nonce, 'runtime')).toBe(false);
    expect((await a).browserId).toBe('runtime');
    expect((await b).browserId).toBe('runtime');
    expect(launch).toHaveBeenCalledTimes(1);
    expect((await m.ensure(p.id)).launched).toBe(false);
  });

  it('keeps malformed preferences unknown and blocks launch', async () => {
    const f = await fixture();
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), '{bad');
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: ['a'.repeat(32)], connectedIds: () => [], roots: [], launch: vi.fn() });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    expect(p.extension.state).toBe('unknown');
    await expect(m.ensure(p.id)).rejects.toThrow('unknown');
  });

  it('discovers a profile from a filesystem root and gives install guidance', async () => {
    const f = await fixture();
    const launch = vi.fn();
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [{ browser: 'edge', executable: f.executable, userDataDir: f.userDataDir }], launch });
    const profiles = await m.list();
    expect(profiles).toHaveLength(1);
    const guidance = await m.openInstall(profiles[0]!.id);
    expect(guidance.url).toBeNull();
    expect(guidance.instructions).toContain('Load unpacked');
    expect(launch).toHaveBeenCalledWith(f.executable, [`--user-data-dir=${f.userDataDir}`, '--profile-directory=Default', 'edge://extensions']);
  });

  it('rejects a launch failure without accepting a late pair', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    let nonce = '';
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: [id], connectedIds: () => ['runtime'], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; throw new Error('spawn failed'); } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    await expect(m.ensure(p.id)).rejects.toThrow('spawn failed');
    expect(await m.pair(nonce, 'runtime')).toBe(false);
  });

  it('persists simultaneous first registrations without losing either profile', async () => {
    const f = await fixture();
    await mkdir(join(f.userDataDir, 'Profile 1'));
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [] });
    const registered = await Promise.all([
      m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir }),
      m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir, profileDirectory: 'Profile 1' }),
    ]);
    expect(new Set(registered.map(p => p.id)).size).toBe(2);
    expect((await new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [] }).list())).toHaveLength(2);
  });

  it('uses secure preference state and chooses an enabled recognized extension', async () => {
    const f = await fixture();
    const disabled = 'a'.repeat(32), enabled = 'b'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [disabled]: { state: 1 }, [enabled]: { state: 0 } } } }));
    await writeFile(join(f.userDataDir, 'Default', 'Secure Preferences'), JSON.stringify({ extensions: { settings: { [disabled]: { state: 0 }, [enabled]: { state: 1 } } } }));
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: [disabled, enabled], connectedIds: () => [], roots: [] });
    expect((await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir })).extension).toEqual({ state: 'enabled', id: enabled });
  });

  it('does not infer absence from partial or malformed preference files', async () => {
    const f = await fixture();
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), '{}');
    await writeFile(join(f.userDataDir, 'Default', 'Secure Preferences'), '{bad');
    const m = new LocalBrowserManager({ configDir: f.root, extensionIds: ['a'.repeat(32)], connectedIds: () => [], roots: [] });
    expect((await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir })).extension.state).toBe('unknown');
  });

  it('deduplicates executable and user-data symlink aliases', async () => {
    const f = await fixture();
    const exeAlias = join(f.root, 'chrome-alias'), dataAlias = join(f.root, 'data-alias');
    await symlink(f.executable, exeAlias);
    await symlink(f.userDataDir, dataAlias);
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [{ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir }, { browser: 'chrome', executable: exeAlias, userDataDir: dataAlias }] });
    expect(await m.list()).toHaveLength(1);
  });

  it('reads profile display name from Local State', async () => {
    const f = await fixture();
    await writeFile(join(f.userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }));
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [{ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir }] });
    expect((await m.list())[0]!.label).toBe('Work');
  });

  it('launches an installed known extension when state is omitted', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { path: 'x' } } } }));
    const connected = new Set<string>();
    let nonce = '';
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [id], connectedIds: () => [...connected], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const work = m.ensure(p.id, 1000);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    connected.add('runtime');
    expect(await m.pair(nonce, 'runtime')).toBe(true);
    expect((await work).browserId).toBe('runtime');
  });

  it('enforces the deadline while launch is pending', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [id], connectedIds: () => [], roots: [], launch: () => new Promise<void>(() => {}) });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    await expect(m.ensure(p.id, 20)).rejects.toThrow('Timed out');
  });

  it('rejects unsafe configured store URLs without opening them', async () => {
    const f = await fixture();
    const launch = vi.fn();
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [], storeUrls: { chrome: 'javascript:alert(1)' }, launch });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    await expect(m.openInstall(p.id)).rejects.toThrow('HTTPS');
    expect(launch).not.toHaveBeenCalled();
  });

  it('includes per-user macOS and Windows browser candidates', () => {
    expect(localBrowserCandidates('darwin', '/fixture/home', {}).some(x => x.executable.includes('/fixture/home/Applications/Google Chrome.app'))).toBe(true);
    expect(localBrowserCandidates('win32', '/fixture/home', { LOCALAPPDATA: '/fixture/local' }).some(x => x.executable === '/fixture/local/Google/Chrome/Application/chrome.exe')).toBe(true);
  });

  it('persists a verified binding for a new manager instance', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    const configDir = join(f.root, 'config');
    let nonce = '';
    const m = new LocalBrowserManager({ configDir, extensionIds: [id], connectedIds: () => ['runtime'], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const work = m.ensure(p.id, 1000);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    expect(await m.pair(nonce, 'runtime')).toBe(true);
    await work;
    const reloaded = new LocalBrowserManager({ configDir, extensionIds: [id], connectedIds: () => ['runtime'], roots: [] });
    expect((await reloaded.list())[0]).toMatchObject({ id: p.id, browserId: 'runtime', connected: true });
    expect(JSON.parse(await readFile(join(configDir, 'browser-profiles.json'), 'utf8')).bindings[p.id]).toBe('runtime');
  });

  it('rejects pairing when catalog persistence fails and does not expose an unverified binding', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    const configDir = join(f.root, 'config');
    let nonce = '';
    const m = new LocalBrowserManager({ configDir, extensionIds: [id], connectedIds: () => ['runtime'], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const work = m.ensure(p.id, 500);
    const rejected = expect(work).rejects.toThrow();
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    await rename(configDir, configDir + '-moved');
    await writeFile(configDir, 'block writes');
    expect(await m.pair(nonce, 'runtime')).toBe(false);
    await rejected;
    expect((await m.list())[0]!.browserId).toBeUndefined();
  });

  it('clears the connection deadline after a successful pair', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    let nonce = '';
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [id], connectedIds: () => ['runtime'], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const work = m.ensure(p.id, 1000);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    await m.pair(nonce, 'runtime');
    await work;
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('rejects an expired nonce even when its browser is connected', async () => {
    const f = await fixture();
    const id = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
    let clock = 0, nonce = '';
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [id], connectedIds: () => ['runtime'], roots: [], now: () => clock, launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const work = m.ensure(p.id, 30);
    const rejected = expect(work).rejects.toThrow('Timed out');
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    clock = 31;
    expect(await m.pair(nonce, 'runtime')).toBe(false);
    await rejected;
  });

  it('rejects a profile directory symlink that leaves its user-data directory', async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.userDataDir, 'Profile 1'));
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [], connectedIds: () => [], roots: [] });
    await expect(m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir, profileDirectory: 'Profile 1' })).rejects.toThrow('outside');
  });

  it('uses installed directory evidence from another recognized ID before a disabled ID', async () => {
    const f = await fixture();
    const disabled = 'a'.repeat(32), installed = 'b'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [disabled]: { state: 0 } } } }));
    await mkdir(join(f.userDataDir, 'Default', 'Extensions', installed), { recursive: true });
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [disabled, installed], connectedIds: () => [], roots: [] });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    expect(p.extension).toEqual({ state: 'installed', id: installed });
  });

  it('rejects a runtime ID already bound to a different local profile', async () => {
    const f = await fixture();
    const other = await fixture();
    const extId = 'a'.repeat(32);
    const pref = JSON.stringify({ extensions: { settings: { [extId]: { state: 1 } } } });
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), pref);
    await writeFile(join(other.userDataDir, 'Default', 'Preferences'), pref);
    const connected = new Set(['runtime']);
    let nonce = '';
    const m = new LocalBrowserManager({ configDir: join(f.root, 'config'), extensionIds: [extId], connectedIds: () => [...connected], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const first = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const second = await m.register({ browser: 'chrome', executable: other.executable, userDataDir: other.userDataDir });
    const firstWork = m.ensure(first.id, 1000);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    expect(await m.pair(nonce, 'runtime')).toBe(true);
    await firstWork;
    nonce = '';
    const secondWork = m.ensure(second.id, 1000);
    const rejected = expect(secondWork).rejects.toThrow('reset identity');
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    expect(await m.pair(nonce, 'runtime')).toBe(false);
    await rejected;
    expect((await m.list()).find(p => p.id === second.id)!.browserId).toBeUndefined();
  });

  it('keeps an old runtime ID resolving after the same local profile pairs a new one', async () => {
    const f = await fixture();
    const extId = 'a'.repeat(32);
    await writeFile(join(f.userDataDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { settings: { [extId]: { state: 1 } } } }));
    const connected = new Set(['old-runtime']);
    let nonce = '';
    const configDir = join(f.root, 'config');
    const m = new LocalBrowserManager({ configDir, extensionIds: [extId], connectedIds: () => [...connected], roots: [], launch: (_exe, args) => { nonce = args.at(-1)!.split('#')[1]!; } });
    const p = await m.register({ browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir });
    const first = m.ensure(p.id, 1000);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    await m.pair(nonce, 'old-runtime');
    await first;
    connected.delete('old-runtime'); connected.add('new-runtime'); nonce = '';
    const second = m.ensure('old-runtime', 1000);
    await vi.waitFor(() => expect(nonce).toBeTruthy());
    await m.pair(nonce, 'new-runtime');
    expect((await second).browserId).toBe('new-runtime');
    const reloaded = new LocalBrowserManager({ configDir, extensionIds: [extId], connectedIds: () => [...connected], roots: [] });
    await reloaded.list();
    expect(reloaded.canResolve('old-runtime')).toBe(true);
    expect((await reloaded.ensure('old-runtime')).browserId).toBe('new-runtime');
  });

  it('skips malformed persisted profile entries while retaining valid ones', async () => {
    const f = await fixture();
    const configDir = join(f.root, 'config');
    await mkdir(configDir);
    await writeFile(join(configDir, 'browser-profiles.json'), JSON.stringify({ profiles: [null, { browser: 'chrome', executable: f.executable, userDataDir: f.userDataDir }], bindings: {} }));
    const m = new LocalBrowserManager({ configDir, extensionIds: [], connectedIds: () => [], roots: [] });
    expect(await m.list()).toHaveLength(1);
  });
});

describe('graphicalEnv', () => {
  // Directory listings; a path exists when it is a listed dir or an entry of one.
  const fs = (dirs: Record<string, string[]>) => ({
    exists: (p: string) => p in dirs || Object.entries(dirs).some(([d, names]) => names.some(n => join(d, n) === p)),
    list: (p: string) => dirs[p] ?? [],
  });

  it('fills in the Wayland display, runtime dir and session bus for a bare agent environment', () => {
    const env = graphicalEnv({ PATH: '/usr/bin' }, 'linux', 1000, fs({ '/run/user/1000': ['wayland-1', 'wayland-1.lock', 'bus'] }));
    expect(env).toMatchObject({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
  });

  it('keeps variables the session already provides', () => {
    const env = graphicalEnv({ DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'x' }, 'linux', 1000, fs({ '/run/user/1000': ['wayland-0'] }));
    expect(env.DISPLAY).toBe(':1');
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('x');
  });

  it('leaves other platforms untouched', () => {
    const base = { PATH: '/bin' };
    expect(graphicalEnv(base, 'darwin', 501)).toBe(base);
  });
});
