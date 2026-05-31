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
