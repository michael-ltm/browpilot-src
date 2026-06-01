import { DEFAULT_PORT } from '@claude-browser/shared';

export const PORT_KEY = 'claudeBrowserPort';

/** Resolve the broker port from storage override, falling back to DEFAULT_PORT. */
export async function resolvePort(): Promise<number> {
  const got = await chrome.storage.local.get(PORT_KEY);
  const v = (got as Record<string, unknown>)[PORT_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_PORT;
}

export function resolveExtensionId(): string {
  return chrome.runtime.id;
}

export const INSTANCE_ID_KEY = 'claudeBrowserInstanceId';
export const LABEL_KEY = 'claudeBrowserLabel';

/** Read-or-generate the stable per-install profile id (the agent-facing browserId). */
export async function getInstanceId(): Promise<string> {
  const got = await chrome.storage.local.get(INSTANCE_ID_KEY);
  const v = (got as Record<string, unknown>)[INSTANCE_ID_KEY];
  if (typeof v === 'string' && v.length > 0) return v;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_ID_KEY]: id });
  return id;
}

/** User-editable display label; defaults to `Profile <first4 of instanceId>`. */
export async function getLabel(instanceId: string): Promise<string> {
  const got = await chrome.storage.local.get(LABEL_KEY);
  const v = (got as Record<string, unknown>)[LABEL_KEY];
  if (typeof v === 'string' && v.length > 0) return v;
  return `Profile ${instanceId.slice(0, 4)}`;
}
