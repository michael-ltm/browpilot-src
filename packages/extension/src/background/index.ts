import {
  type ExecuteCdpParams,
  type AttachParams,
  type DetachParams,
  type NewTabParams,
  type SwitchTabParams,
  type CloseTabParams,
  type GetHistoryParams,
  Method,
} from '@claude-browser/shared';
import {
  Transport,
  RECONNECT_ALARM,
  KEEPALIVE_ALARM,
  KEEPALIVE_PERIOD_MIN,
  KEEPALIVE_PING_MS,
} from './transport';
import { handleExecuteCdp, attach, detach, registerCdpEventForwarding, registerAutoReattach, checkIdle } from './relay';
import { getTabs, newTab, switchTab, closeTab, getHistory } from './helpers';
import { resolvePort, resolveExtensionId, getInstanceId, getLabel, resolveIdleDetachMin } from './config';

/** Detach any debugger idle past the user's configured timeout (0 = never). */
async function sweepIdle(): Promise<void> {
  await checkIdle(await resolveIdleDetachMin());
}

/** Pure wiring: register handlers, event forwarding, alarm reconnect, eager connect. */
export function bootstrap(transport: Transport): void {
  transport.registerHandler(Method.EXECUTE_CDP, (p) => handleExecuteCdp(p as ExecuteCdpParams));
  transport.registerHandler(Method.ATTACH, async (p) => {
    await attach({ tabId: (p as AttachParams).tabId });
    return {};
  });
  transport.registerHandler(Method.DETACH, async (p) => {
    await detach({ tabId: (p as DetachParams).tabId });
    return {};
  });
  transport.registerHandler(Method.GET_TABS, () => getTabs());
  transport.registerHandler(Method.NEW_TAB, (p) => newTab(p as NewTabParams));
  transport.registerHandler(Method.SWITCH_TAB, (p) => switchTab(p as SwitchTabParams));
  transport.registerHandler(Method.CLOSE_TAB, (p) => closeTab(p as CloseTabParams));
  transport.registerHandler(Method.GET_HISTORY, (p) => getHistory(p as GetHistoryParams));
  transport.registerHandler(Method.PING, () => ({ pong: true }));

  registerCdpEventForwarding(transport);
  registerAutoReattach();

  // A persistent watchdog so an idle profile can never get stuck offline. While the
  // socket is open this alarm sits idle; the moment the SW is revived to fire it (after
  // an abrupt death that skipped `ws.onclose`), `connect()` restores the link. Created
  // here on every SW wake — `chrome.alarms.create` with the same name is idempotent, so
  // re-arming costs nothing — and is never cleared, unlike RECONNECT_ALARM.
  void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });

  // Either alarm waking us is a cue to ensure the socket is up. connect() is a no-op
  // when the socket is already OPEN/CONNECTING, so an unconditional call is safe.
  // The keepalive tick (~1 min) also drives the idle-detach sweep: when CDP has been
  // quiet past the user's timeout, drop the debugger so Chrome's banner clears.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM || alarm.name === KEEPALIVE_ALARM) transport.connect();
    if (alarm.name === KEEPALIVE_ALARM) void sweepIdle();
  });

  // Keep the worker awake while the device is: a trivial chrome API call every <30s
  // resets MV3's idle timer so it never reaches the suspension cutoff. This runs
  // unconditionally (even with no socket) so the extension is always ready to connect
  // the instant a Claude session appears, rather than waiting for the watchdog tick.
  setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch {
      /* worker tearing down — the keepalive alarm will revive it */
    }
  }, KEEPALIVE_PING_MS);

  // Eager connect on every SW startup.
  transport.connect();
}

// Top-level side effects: runs on every service-worker wake.
async function main(): Promise<void> {
  const port = await resolvePort();
  const extensionId = resolveExtensionId();
  const instanceId = await getInstanceId();
  const label = await getLabel(instanceId);
  const transport = new Transport({ port, extensionId, instanceId, label });
  bootstrap(transport);
}

void main();
