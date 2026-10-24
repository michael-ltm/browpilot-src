import { DEFAULT_PORT } from '@browpilot/shared';

export const PORT_KEY = 'browpilotPort';

/** Resolve the broker port from storage override, falling back to DEFAULT_PORT. */
export async function resolvePort(): Promise<number> {
  const got = await chrome.storage.local.get(PORT_KEY);
  const v = (got as Record<string, unknown>)[PORT_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_PORT;
}

export function resolveExtensionId(): string {
  return chrome.runtime.id;
}

export const INSTANCE_ID_KEY = 'browpilotInstanceId';
export const LABEL_KEY = 'browpilotLabel';

export const IDLE_DETACH_MIN_KEY = 'browpilotIdleDetachMin';
/** Minutes of CDP inactivity before the debugger auto-detaches (0 = never). */
export const DEFAULT_IDLE_DETACH_MIN = 30;

/**
 * Resolve the idle auto-detach timeout (minutes) from storage. Accepts any
 * non-negative integer (0 disables); anything else falls back to the default.
 */
export async function resolveIdleDetachMin(): Promise<number> {
  const got = await chrome.storage.local.get(IDLE_DETACH_MIN_KEY);
  const v = (got as Record<string, unknown>)[IDLE_DETACH_MIN_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DEFAULT_IDLE_DETACH_MIN;
}

/** Read-or-generate the stable per-install profile id (the agent-facing browserId). */
export async function getInstanceId(): Promise<string> {
  const got = await chrome.storage.local.get(INSTANCE_ID_KEY);
  const v = (got as Record<string, unknown>)[INSTANCE_ID_KEY];
  if (typeof v === 'string' && v.length > 0) return v;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_ID_KEY]: id });
  return id;
}

/** The signed-in Google account's email local-part, or null if unavailable. */
export async function getProfileEmailName(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' as chrome.identity.AccountStatus }, (info) => {
        const email = info?.email ?? '';
        resolve(email ? email.split('@')[0]! || email : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Resolution order: explicit custom label -> Google email local-part -> Profile <shortId>. */
export async function getLabel(instanceId: string): Promise<string> {
  const got = (await chrome.storage.local.get(LABEL_KEY)) as Record<string, unknown>;
  const v = got[LABEL_KEY];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  const email = await getProfileEmailName();
  if (email) return email;
  return `Profile ${instanceId.slice(0, 4)}`;
}

/** Pre-rename storage keys and the keys that replaced them. */
const LEGACY_KEYS: Record<string, string> = {
  claudeBrowserPort: PORT_KEY,
  claudeBrowserInstanceId: INSTANCE_ID_KEY,
  claudeBrowserLabel: LABEL_KEY,
  claudeBrowserIdleDetachMin: IDLE_DETACH_MIN_KEY,
  claudeBrowserStatus: 'browpilotStatus',
};
const LEGACY_ALARMS = ['claude-browser-reconnect', 'claude-browser-keepalive'];

/**
 * Carry settings stored under the claude-browser keys over to the Browpilot
 * keys, keeping the instance id (and so the profile pairing) stable. Values
 * already present under a new key win. Old periodic alarms are cleared so they
 * stop waking the worker.
 */
export async function migrateLegacyStorage(): Promise<void> {
  const got = (await chrome.storage.local.get([...Object.keys(LEGACY_KEYS), ...Object.values(LEGACY_KEYS)])) as Record<string, unknown>;
  const legacy = Object.keys(LEGACY_KEYS).filter((k) => k in got);
  if (legacy.length > 0) {
    const moved: Record<string, unknown> = {};
    for (const k of legacy) if (!(LEGACY_KEYS[k]! in got)) moved[LEGACY_KEYS[k]!] = got[k];
    if (Object.keys(moved).length > 0) await chrome.storage.local.set(moved);
    await chrome.storage.local.remove(legacy);
  }
  await Promise.all(LEGACY_ALARMS.map((name) => chrome.alarms.clear(name)));
}
