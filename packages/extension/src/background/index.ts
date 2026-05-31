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
import { Transport, RECONNECT_ALARM } from './transport';
import { handleExecuteCdp, attach, detach, registerCdpEventForwarding, registerAutoReattach } from './relay';
import { getTabs, newTab, switchTab, closeTab, getHistory } from './helpers';
import { resolvePort, resolveExtensionId } from './config';

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

  // The alarm survives service-worker death: when Chrome wakes the SW to fire it,
  // we reconnect (the connection is also re-established by the top-level eager connect).
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) transport.connect();
  });

  // Eager connect on every SW startup.
  transport.connect();
}

// Top-level side effects: runs on every service-worker wake.
async function main(): Promise<void> {
  const port = await resolvePort();
  const extensionId = resolveExtensionId();
  const transport = new Transport({ port, extensionId });
  bootstrap(transport);
}

void main();
