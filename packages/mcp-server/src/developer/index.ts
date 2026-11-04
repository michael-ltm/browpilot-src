import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, hostname, platform } from 'node:os';
import { join, resolve, basename, dirname, isAbsolute, sep } from 'node:path';
import { mkdir, mkdtemp, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import WebSocket from 'ws';
import { CONFIG_DIR } from '@browpilot/shared';
import { graphicalEnv } from '@browpilot/shared/node';

export interface DeveloperTarget { targetId: string; type: string; title: string; url: string; [key: string]: unknown }
export interface ExtensionTargets { extensionId: string; targets: DeveloperTarget[] }
export interface LaunchOptions {
  executable: string;
  userDataDir?: string;
  /** Unpacked extension to install once CDP is up (Extensions.loadUnpacked, persists in the profile). */
  extensionPath?: string;
  /** Extra browser flags. */
  args?: string[];
  /**
   * The profile is open in a running browser: ask it to quit (SIGTERM, like the Quit menu, so the
   * session is saved), then start it again with DevTools enabled and the previous session restored.
   * On Linux the running browser's own flags are carried over. The relaunched browser is left
   * running when this session closes.
   */
  takeOver?: boolean;
}
export interface DeveloperEvent { sequence: number; time: number; method: string; params?: Record<string, unknown>; sessionId?: string; targetId?: string }
interface Pending { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
interface Attempt { controller: AbortController; socket?: WebSocket; child?: ChildProcess; cancelled: boolean }
const MAX_EVENTS = 1000;
const MAX_EVENT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10000;
const STARTUP_TIMEOUT_MS = 15000;
const QUIT_TIMEOUT_MS = 20000;
// Flags that the relaunch sets itself; never carried over from the browser being replaced.
const OWN_FLAGS = /^--(user-data-dir|remote-debugging-[a-z]+|enable-unsafe-extension-debugging|restore-last-session|no-startup-window)(=|$)/;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Chromium's SingletonLock is a symlink to "<host>-<pid>"; return the pid when that process is alive. */
async function lockOwner(userDataDir: string): Promise<number | null> {
  let target: string;
  try { target = await readlink(join(userDataDir, 'SingletonLock')); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'EINVAL') throw new Error('Developer profile is locked'); // not a symlink (Windows / unusual setup)
    throw error;
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  // A lock from another machine (shared profile directory) or in an unknown format is never ours to break.
  if (!m || m[1] !== hostname()) throw new Error('Developer profile is locked');
  const pid = Number(m[2]);
  return alive(pid) ? pid : null;
}

/** The running browser's own flags (Linux /proc only), minus the ones the relaunch controls. */
async function carriedFlags(pid: number): Promise<string[]> {
  if (platform() !== 'linux') return [];
  try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean).slice(1);
    return argv.filter(arg => /^--[a-z]/i.test(arg) && !OWN_FLAGS.test(arg));
  } catch { return []; }
}

async function canonical(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current)); current = parent;
    }
  }
}

async function generatedProfile(): Promise<string> {
  const base = join(homedir(), CONFIG_DIR, 'developer-profiles');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'profile-'));
}

function dailyRoots(): string[] {
  const home = homedir();
  if (platform() === 'darwin') return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Microsoft Edge', 'Microsoft Edge Beta', 'Chromium'].map(name => join(home, 'Library', 'Application Support', name));
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome SxS', 'Microsoft/Edge', 'Microsoft/Edge Beta', 'Chromium'].map(name => join(local, name, 'User Data'));
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'].map(name => join(config, name));
}

function isInside(path: string, root: string): boolean { return path === root || path.startsWith(root + sep); }
function validSocketUrl(value: unknown, port: number, expectedPath?: string): URL {
  if (typeof value !== 'string') throw new Error('Missing CDP socket URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid CDP socket URL'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password || url.search || url.hash) throw new Error('CDP socket must use loopback');
  if (expectedPath && url.pathname !== expectedPath) throw new Error('CDP socket does not match launched browser');
  return url;
}

export class DeveloperBrowser {
  private socket?: WebSocket;
  private child?: ChildProcess;
  private attempt?: Attempt;
  private nextId = 1;
  private nextSequence = 1;
  private pending = new Map<number, Pending>();
  private buffer: DeveloperEvent[] = [];
  private sessionTargets = new Map<string, string>();
  private targetTypes = new Map<string, string>();
  private liveContexts = new Map<string, Map<number, Record<string, unknown>>>();
  private runtimeEnabled = new Set<string>();
  private closing?: Promise<void>;

  private begin(): Attempt {
    if (this.closing || this.attempt || this.socket) throw new Error('Developer browser connection already in progress, closing, or connected');
    const attempt: Attempt = { controller: new AbortController(), cancelled: false };
    this.attempt = attempt;
    return attempt;
  }
  private current(attempt: Attempt): void { if (this.attempt !== attempt || attempt.cancelled) throw new Error('Developer browser connection cancelled'); }

  async launch(options: LaunchOptions): Promise<{ port: number; userDataDir: string; tookOver?: number; extensionId?: string }> {
    if (this.child && this.child.exitCode === null && this.child.pid) throw new Error('Owned browser is still running; close it before launching another');
    const attempt = this.begin();
    let deadline = Date.now() + STARTUP_TIMEOUT_MS;
    try {
      if (!options.executable || !isAbsolute(options.executable)) throw new Error('Absolute browser executable required');
      // Generated profiles are intentionally retained for subsequent debugging sessions.
      // The base dir is only created when a profile is generated, so an explicit userDataDir leaves home untouched.
      const userDataDir = options.userDataDir ? resolve(options.userDataDir) : await generatedProfile();
      this.current(attempt);
      await this.validateProfile(userDataDir); this.current(attempt);
      const owner = await lockOwner(userDataDir); this.current(attempt);
      let carried: string[] = [];
      if (owner !== null) {
        if (!options.takeOver) throw new Error(`Developer profile is open in a running browser (pid ${owner}); pass takeOver: true to restart it with DevTools enabled`);
        carried = await carriedFlags(owner);
        process.kill(owner, 'SIGTERM');
        const quitBy = Date.now() + QUIT_TIMEOUT_MS;
        while (alive(owner) && Date.now() < quitBy) await this.delay(attempt, 200);
        if (alive(owner)) throw new Error(`Browser pid ${owner} did not quit within ${QUIT_TIMEOUT_MS / 1000}s; nothing was restarted`);
        deadline = Date.now() + STARTUP_TIMEOUT_MS;
      }
      // owner === null with a lock present means this host's browser crashed and left it; Chromium replaces it.
      await mkdir(userDataDir, { recursive: true }); this.current(attempt);
      // A reused profile may contain a port file from another browser. Only a fresh file can identify this launch.
      try { await unlink(join(userDataDir, 'DevToolsActivePort')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.current(attempt);
      // --enable-unsafe-extension-debugging lets CDP install unpacked extensions (Extensions.loadUnpacked)
      // and is what makes the extension tools below work on stock Chrome, which ignores --load-extension.
      const args = [
        ...carried,
        ...(options.args ?? []),
        `--user-data-dir=${userDataDir}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--enable-unsafe-extension-debugging', '--no-first-run',
        ...(owner !== null ? ['--restore-last-session'] : []),
      ];
      // A taken-over daily browser must outlive this MCP session, so it is detached and not owned.
      const child = spawn(options.executable, args, { stdio: 'ignore', env: graphicalEnv(process.env), detached: owner !== null });
      if (owner !== null) child.unref();
      attempt.child = child;
      if (owner === null) this.child = child;
      let failed: Error | undefined;
      child.once('error', error => { failed = error; });
      child.once('exit', (code, signal) => { failed = new Error(`Browser exited before CDP startup (${code ?? signal})`); });
      while (Date.now() < deadline) {
        this.current(attempt);
        if (failed) throw failed;
        try {
          const lines = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
          const port = Number(lines[0]);
          if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[^/]+$/.test(lines[1] ?? '')) {
            await this.connectAttempt(attempt, port, lines[1], deadline);
            attempt.child = undefined; // connected: a later failure must not kill the browser
            const extensionId = options.extensionPath ? await this.loadExtension(options.extensionPath) : undefined;
            return { port, userDataDir, ...(owner !== null ? { tookOver: owner } : {}), ...(extensionId ? { extensionId } : {}) };
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await this.delay(attempt, Math.min(50, deadline - Date.now()));
      }
      throw new Error('Timed out waiting for DevToolsActivePort');
    } catch (error) { await this.cleanupAttempt(attempt); throw error; }
    finally { if (this.attempt === attempt) this.attempt = undefined; }
  }

  private async validateProfile(path: string): Promise<void> {
    const actual = await canonical(path);
    for (const root of dailyRoots()) {
      if (isInside(actual, await canonical(root))) throw new Error('Default browser profile is not permitted');
    }
    const normalized = actual.toLowerCase().replaceAll('\\', '/');
    if (/\/(google-chrome|chromium|microsoft-edge|chrome|edge)\/(user data|default)$/.test(normalized) || basename(actual).toLowerCase() === 'default' && /(chrome|chromium|edge)/i.test(dirname(actual))) throw new Error('Default browser profile is not permitted');
  }

  async connect(port: number): Promise<void> {
    const attempt = this.begin();
    try { await this.connectAttempt(attempt, port, undefined, Date.now() + 5000); }
    catch (error) { await this.cleanupAttempt(attempt); throw error; }
    finally { if (this.attempt === attempt) this.attempt = undefined; }
  }

  private async connectAttempt(attempt: Attempt, port: number, expectedPath: string | undefined, deadline: number): Promise<void> {
    this.current(attempt);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CDP port');
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('CDP startup timed out');
    const timer = setTimeout(() => attempt.controller.abort(new Error('CDP startup timed out')), remaining);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: attempt.controller.signal, redirect: 'error' });
      this.current(attempt);
      if (!response.ok) throw new Error(`CDP discovery failed (${response.status})`);
      const data: unknown = await response.json(); this.current(attempt);
      const url = validSocketUrl((data && typeof data === 'object' ? (data as Record<string, unknown>).webSocketDebuggerUrl : undefined), port, expectedPath);
      const socket = new WebSocket(url.toString()); attempt.socket = socket;
      // ws emits a deferred error when a CONNECTING socket is terminated. Keep this handler through closure.
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        const abort = () => { socket.terminate(); reject(attempt.controller.signal.reason ?? new Error('CDP connection cancelled')); };
        if (attempt.controller.signal.aborted) return abort();
        attempt.controller.signal.addEventListener('abort', abort, { once: true });
        socket.once('open', () => { attempt.controller.signal.removeEventListener('abort', abort); resolve(); });
        socket.once('error', error => { attempt.controller.signal.removeEventListener('abort', abort); reject(error); });
      });
      this.current(attempt);
      this.socket = socket;
      socket.on('message', data => { if (this.socket === socket) this.onMessage(data.toString()); });
      socket.on('close', () => this.disconnected(socket, new Error('CDP socket closed')));
      socket.on('error', error => this.disconnected(socket, error));
    } finally { clearTimeout(timer); }
  }

  private delay(attempt: Attempt, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { attempt.controller.signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
      const abort = () => { clearTimeout(timer); reject(new Error('Developer browser connection cancelled')); };
      attempt.controller.signal.addEventListener('abort', abort, { once: true });
      if (attempt.controller.signal.aborted) abort();
    });
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return; message = parsed as Record<string, unknown>; } catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      const error = message.error;
      if (error && typeof error === 'object') { const detail = error as Record<string, unknown>; pending.reject(new Error(`CDP ${detail.code ?? ''}: ${detail.message ?? 'command failed'}`)); }
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params as Record<string, unknown> : undefined;
    const lifecycle = message.method === 'Target.attachedToTarget' || message.method === 'Target.detachedFromTarget';
    const sessionId = lifecycle && typeof params?.sessionId === 'string' ? params.sessionId :
      typeof message.sessionId === 'string' ? message.sessionId : undefined;
    let targetId = sessionId ? this.sessionTargets.get(sessionId) : undefined;
    const info = params?.targetInfo && typeof params.targetInfo === 'object' ? params.targetInfo as Record<string, unknown> : undefined;
    if (info && typeof info.targetId === 'string' && typeof info.type === 'string') this.targetTypes.set(info.targetId, info.type);
    if (message.method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string' && typeof info?.targetId === 'string') {
      this.sessionTargets.set(params.sessionId, info.targetId); targetId = info.targetId;
    } else if (message.method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') {
      targetId = this.sessionTargets.get(params.sessionId); this.sessionTargets.delete(params.sessionId);
      this.liveContexts.delete(params.sessionId); this.runtimeEnabled.delete(params.sessionId);
    } else if (message.method === 'Target.targetDestroyed' && typeof params?.targetId === 'string') {
      targetId = params.targetId; this.targetTypes.delete(targetId);
      for (const [session, target] of this.sessionTargets) if (target === targetId) { this.sessionTargets.delete(session); this.liveContexts.delete(session); this.runtimeEnabled.delete(session); }
    } else if (typeof params?.targetId === 'string') targetId = params.targetId;
    if (sessionId) this.reduceContextEvent(sessionId, message.method, params);
    const safeParams = params && Buffer.byteLength(JSON.stringify(params)) <= MAX_EVENT_BYTES ? params : params ? { truncated: true } : undefined;
    const event: DeveloperEvent = { sequence: this.nextSequence++, time: Date.now(), method: message.method.slice(0, 256), params: safeParams, sessionId, targetId };
    this.buffer.push(event); if (this.buffer.length > MAX_EVENTS) this.buffer.shift();
  }

  private disconnected(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.buffer = []; this.sessionTargets.clear(); this.targetTypes.clear(); this.liveContexts.clear(); this.runtimeEnabled.clear();
  }

  private reduceContextEvent(sessionId: string, method: string, params?: Record<string, unknown>): void {
    if (method === 'Runtime.executionContextCreated') {
      const context = params?.context;
      if (context && typeof context === 'object' && !Array.isArray(context) && typeof (context as Record<string, unknown>).id === 'number') {
        const map = this.liveContexts.get(sessionId) ?? new Map<number, Record<string, unknown>>();
        map.set((context as Record<string, unknown>).id as number, context as Record<string, unknown>); this.liveContexts.set(sessionId, map);
      }
    } else if (method === 'Runtime.executionContextDestroyed' && typeof params?.executionContextId === 'number') {
      this.liveContexts.get(sessionId)?.delete(params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') this.liveContexts.delete(sessionId);
  }

  async contexts(sessionId: string): Promise<Array<Record<string, unknown>>> {
    if (!sessionId) throw new Error('Session ID required');
    if (!this.runtimeEnabled.has(sessionId)) { await this.command({ method: 'Runtime.enable', sessionId }); this.runtimeEnabled.add(sessionId); }
    return [...(this.liveContexts.get(sessionId)?.values() ?? [])];
  }

  async targets(): Promise<DeveloperTarget[]> {
    const result = await this.command({ method: 'Target.getTargets' }) as { targetInfos?: DeveloperTarget[] };
    for (const target of result.targetInfos ?? []) this.targetTypes.set(target.targetId, target.type);
    return result.targetInfos ?? [];
  }

  async attach(targetId: string): Promise<{ sessionId: string }> {
    if (!targetId) throw new Error('Target ID required');
    if (!this.targetTypes.has(targetId)) await this.targets();
    if (!this.targetTypes.has(targetId)) throw new Error('Target not found');
    const result = await this.command({ method: 'Target.attachToTarget', params: { targetId, flatten: true } }) as { sessionId: string };
    if (!result.sessionId) throw new Error('CDP did not return a session ID');
    this.sessionTargets.set(result.sessionId, targetId);
    return { sessionId: result.sessionId };
  }

  /** Every chrome-extension:// target (service workers, background pages, open extension pages), grouped by extension. */
  async extensions(): Promise<ExtensionTargets[]> {
    const groups = new Map<string, DeveloperTarget[]>();
    for (const target of await this.targets()) {
      const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(target.url)?.[1];
      if (id) groups.set(id, [...(groups.get(id) ?? []), target]);
    }
    return [...groups].map(([extensionId, targets]) => ({ extensionId, targets }));
  }

  /** Install an unpacked extension (needs the browser started by launch, which adds --enable-unsafe-extension-debugging). */
  async loadExtension(path: string): Promise<string> {
    if (!path || !isAbsolute(path)) throw new Error('Absolute extension path required');
    const result = await this.command({ method: 'Extensions.loadUnpacked', params: { path: resolve(path) } }) as { id?: string };
    if (!result?.id) throw new Error('Extensions.loadUnpacked returned no extension id');
    return result.id;
  }

  /**
   * Evaluate in an extension's own context, with its chrome.* APIs (storage, runtime, tabs, ...).
   * Uses its service worker or background page when running; otherwise opens the extension's
   * manifest.json in a background tab, which runs in the extension origin with the same APIs, and
   * closes it afterwards. An expression there can wake the worker with chrome.runtime.sendMessage.
   */
  async extensionEval(extensionId: string, expression: string, where: 'auto' | 'worker' | 'page' = 'auto'): Promise<{ value: unknown; target: string }> {
    if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('extensionId must be a 32-letter extension id');
    if (!expression) throw new Error('expression required');
    const mine = (await this.extensions()).find(e => e.extensionId === extensionId)?.targets ?? [];
    let target = where === 'page' ? undefined : mine.find(t => t.type === 'service_worker' || t.type === 'background_page');
    if (!target && where === 'worker') throw new Error('Extension has no running service worker; use where "auto" or "page"');
    let opened: string | undefined;
    if (!target) {
      const created = await this.command({ method: 'Target.createTarget', params: { url: `chrome-extension://${extensionId}/manifest.json`, background: true } }) as { targetId: string };
      opened = created.targetId;
      target = { targetId: created.targetId, type: 'page', title: '', url: `chrome-extension://${extensionId}/manifest.json` };
      this.targetTypes.set(created.targetId, 'page');
    }
    try {
      const { sessionId } = await this.attach(target.targetId);
      try {
        const evaluate = (expr: string) => this.command({ method: 'Runtime.evaluate', sessionId, params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }) as Promise<{ result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>;
        if (target.type === 'page') {
          // A freshly opened extension page gets its chrome.* bindings shortly after the document starts.
          const deadline = Date.now() + 5000;
          while (!(await evaluate("typeof chrome === 'object' && !!chrome.runtime && !!chrome.runtime.id")).result?.value && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
        }
        const result = await evaluate(expression);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
        return { value: result.result?.value ?? result.result?.description ?? null, target: `${target.type} ${target.url}` };
      } finally {
        await this.command({ method: 'Target.detachFromTarget', params: { sessionId } }).catch(() => {});
      }
    } finally {
      if (opened) await this.command({ method: 'Target.closeTarget', params: { targetId: opened } }).catch(() => {});
    }
  }

  command(options: { method: string; params?: Record<string, unknown>; sessionId?: string }): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    if (!options.method) return Promise.reject(new Error('CDP method required'));
    if (options.method.startsWith('Emulation.') && options.sessionId) {
      const targetId = this.sessionTargets.get(options.sessionId);
      const type = targetId ? this.targetTypes.get(targetId) : undefined;
      if (type && (type.includes('worker') || type.includes('worklet'))) return Promise.reject(new Error('Page emulation is unavailable on worker targets'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let payload: string;
      try { payload = JSON.stringify({ id, method: options.method, params: options.params ?? {}, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }); }
      catch (error) { reject(error); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timed out: ${options.method}`)); }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(payload, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  events(options: { sessionId?: string; since?: number; clear?: boolean } = {}): DeveloperEvent[] {
    const selected = this.buffer.filter(event => (!options.sessionId || event.sessionId === options.sessionId) && (options.since === undefined || event.sequence > options.since));
    if (options.clear) { const ids = new Set(selected.map(event => event.sequence)); this.buffer = this.buffer.filter(event => !ids.has(event.sequence)); }
    return selected;
  }

  private async cleanupAttempt(attempt: Attempt): Promise<void> {
    attempt.cancelled = true; attempt.controller.abort();
    const socket = attempt.socket;
    if (socket) { this.disconnected(socket, new Error('Developer browser closed')); socket.terminate(); }
    const child = attempt.child;
    if (child && this.child === child) this.child = undefined;
    if (child && child.exitCode === null && child.pid) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.doClose();
    this.closing = closing.finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const attempt = this.attempt;
    if (attempt) { await this.cleanupAttempt(attempt); if (this.attempt === attempt) this.attempt = undefined; }
    const socket = this.socket;
    if (socket) { this.disconnected(socket, new Error('Developer browser closed')); socket.terminate(); }
    const child = this.child; this.child = undefined;
    if (child && child.exitCode === null && child.pid) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
