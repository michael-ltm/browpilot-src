import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join, resolve, basename, dirname, isAbsolute, sep } from 'node:path';
import { mkdir, mkdtemp, readFile, lstat, realpath, unlink } from 'node:fs/promises';
import WebSocket from 'ws';

export interface DeveloperTarget { targetId: string; type: string; title: string; url: string; [key: string]: unknown }
export interface DeveloperEvent { sequence: number; time: number; method: string; params?: Record<string, unknown>; sessionId?: string; targetId?: string }
interface Pending { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
interface Attempt { controller: AbortController; socket?: WebSocket; child?: ChildProcess; cancelled: boolean }
const MAX_EVENTS = 1000;
const MAX_EVENT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10000;
const STARTUP_TIMEOUT_MS = 15000;

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

  async launch(options: { executable: string; userDataDir?: string; extensionPath?: string }): Promise<{ port: number; userDataDir: string }> {
    if (this.child && this.child.exitCode === null && this.child.pid) throw new Error('Owned browser is still running; close it before launching another');
    const attempt = this.begin();
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    try {
      if (!options.executable || !isAbsolute(options.executable)) throw new Error('Absolute browser executable required');
      const base = join(homedir(), '.claude-browser', 'developer-profiles');
      await mkdir(base, { recursive: true }); this.current(attempt);
      // Generated profiles are intentionally retained for subsequent debugging sessions.
      const userDataDir = options.userDataDir ? resolve(options.userDataDir) : await mkdtemp(join(base, 'profile-'));
      await this.validateProfile(userDataDir); this.current(attempt);
      try { await lstat(join(userDataDir, 'SingletonLock')); throw new Error('Developer profile is locked'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(userDataDir, { recursive: true }); this.current(attempt);
      // A reused profile may contain a port file from another browser. Only a fresh file can identify this launch.
      try { await unlink(join(userDataDir, 'DevToolsActivePort')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.current(attempt);
      const args = [`--user-data-dir=${userDataDir}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--no-first-run'];
      if (options.extensionPath) args.push(`--load-extension=${resolve(options.extensionPath)}`);
      const child = spawn(options.executable, args, { stdio: 'ignore' });
      attempt.child = child; this.child = child;
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
            return { port, userDataDir };
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
