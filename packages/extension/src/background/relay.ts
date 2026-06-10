import {
  type CdpTarget,
  type ExecuteCdpParams,
  type ExecuteCdpResult,
  type OnCdpEventParams,
  Notif,
} from '@claude-browser/shared';
import { IdleDetacher } from './idle';

/** Minimal surface of Transport that the relay needs (kept narrow for testability). */
export interface CdpEventSink {
  sendNotification(method: string, params?: unknown): void;
}

const CDP_VERSION = '1.3';

/**
 * One idle-detach tracker for the whole worker: any CDP command resets its
 * countdown; checkIdle() (driven by the keepalive alarm) detaches every tab we
 * hold once the browser has been idle past the configured timeout, clearing
 * Chrome's "started debugging this browser" banner. The next tool call re-attaches.
 */
const idle = new IdleDetacher((tabId) => chrome.debugger.detach({ tabId }));

/** Detach debuggers idle for >= idleMin minutes (0 disables). Returns detached tabIds. */
export function checkIdle(idleMin: number): Promise<number[]> {
  return idle.check(idleMin * 60_000);
}

function toDebuggee(target: CdpTarget): chrome.debugger.Debuggee {
  if (typeof target.tabId === 'number') return { tabId: target.tabId };
  if (typeof target.targetId === 'string') return { targetId: target.targetId };
  throw new Error('CdpTarget requires tabId or targetId');
}

/** executeCdp -> chrome.debugger.sendCommand pass-through. */
export async function handleExecuteCdp(params: ExecuteCdpParams): Promise<ExecuteCdpResult> {
  idle.recordActivity();
  const debuggee = toDebuggee(params.target);
  return chrome.debugger.sendCommand(debuggee, params.method, params.params);
}

function isAlreadyAttached(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already attached/i.test(msg);
}

/**
 * Attach the debugger at protocol 1.3 (tolerating already-attached), pin
 * deviceScaleFactor to 1 so screenshot px == CSS px == input coords, and enable
 * the Runtime + Log domains so console CDP events flow to the broker buffer.
 */
export async function attach(target: CdpTarget): Promise<void> {
  const debuggee = toDebuggee(target);
  try {
    await chrome.debugger.attach(debuggee, CDP_VERSION);
  } catch (err) {
    if (!isAlreadyAttached(err)) throw err;
  }
  await chrome.debugger.sendCommand(debuggee, 'Emulation.setDeviceMetricsOverride', {
    width: 0,
    height: 0,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', {});
  await chrome.debugger.sendCommand(debuggee, 'Log.enable', {});
  if (typeof target.tabId === 'number') idle.noteAttached(target.tabId);
}

export async function detach(target: CdpTarget): Promise<void> {
  if (typeof target.tabId === 'number') idle.noteDetached(target.tabId);
  await chrome.debugger.detach(toDebuggee(target));
}

/** Forward every CDP event to the agent as an ON_CDP_EVENT notification. */
export function registerCdpEventForwarding(transport: CdpEventSink): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const evt: OnCdpEventParams = {
      source: { tabId: source.tabId, targetId: source.targetId },
      method,
      params: params ?? null,
    };
    transport.sendNotification(Notif.ON_CDP_EVENT, evt);
  });
}

/** Re-attach the debugger when Chrome detaches us for any reason other than a user cancel. */
export function registerAutoReattach(): void {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (reason === 'canceled_by_user') return;
    // A detach we triggered ourselves on idle timeout — leave it detached (one-shot).
    if (typeof source.tabId === 'number' && idle.shouldSuppressReattach(source.tabId)) {
      idle.clearSuppressed(source.tabId);
      return;
    }
    const target: CdpTarget = { tabId: source.tabId, targetId: source.targetId };
    void attach(target).catch(() => {
      /* best-effort; the heartbeat/reconnect path is the backstop */
    });
  });
}
