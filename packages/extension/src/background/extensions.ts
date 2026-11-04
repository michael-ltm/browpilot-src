import {
  type ExtensionInfo,
  type ListExtensionsResult,
  type ManageExtensionParams,
  type ManageExtensionResult,
  type MessageExtensionParams,
  type MessageExtensionResult,
} from '@browpilot/shared';

const DEFAULT_MESSAGE_TIMEOUT_MS = 15_000;

function toInfo(e: chrome.management.ExtensionInfo): ExtensionInfo {
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    enabled: e.enabled,
    installType: e.installType,
    type: e.type,
    optionsUrl: e.optionsUrl || undefined,
    description: e.description || undefined,
    mayDisable: e.mayDisable,
    isSelf: e.id === chrome.runtime.id,
    disabledReason: e.disabledReason,
  };
}

/** Extensions and apps in this profile (themes and Chrome's own component extensions are skipped by the API). */
export async function listExtensions(): Promise<ListExtensionsResult> {
  const all = await chrome.management.getAll();
  return { extensions: all.filter((e) => e.type !== 'theme').map(toInfo) };
}

async function getInfo(id: string): Promise<chrome.management.ExtensionInfo> {
  try {
    return await chrome.management.get(id);
  } catch {
    throw new Error(`extension ${id} is not installed in this profile`);
  }
}

/**
 * reload: disable + enable, which re-reads an unpacked extension from disk (same as the
 * reload button on chrome://extensions). Reloading Browpilot itself replies first and
 * then restarts the worker; the socket reconnects on its own.
 */
export async function manageExtension(params: ManageExtensionParams): Promise<ManageExtensionResult> {
  const { id, action } = params;
  if (id === chrome.runtime.id) {
    if (action === 'reload') {
      setTimeout(() => chrome.runtime.reload(), 200);
      return { detail: 'Browpilot is reloading; it reconnects in a few seconds' };
    }
    if (action !== 'open_options') throw new Error(`cannot ${action} Browpilot itself`);
  }
  const info = await getInfo(id);
  switch (action) {
    case 'open_options': {
      if (!info.optionsUrl) throw new Error(`${info.name} has no options page`);
      const tab = await chrome.tabs.create({ url: info.optionsUrl });
      return { extension: toInfo(info), tabId: tab.id };
    }
    case 'enable':
    case 'disable':
    case 'reload': {
      if (!info.mayDisable) throw new Error(`${info.name} is managed by policy and cannot be ${action}d`);
      if (action !== 'enable') await chrome.management.setEnabled(id, false);
      if (action !== 'disable') await chrome.management.setEnabled(id, true);
      return { extension: toInfo(await getInfo(id)) };
    }
    default:
      throw new Error(`unknown action ${String(action)}`);
  }
}

/** Send one message to another extension's chrome.runtime.onMessageExternal and return its reply. */
export async function messageExtension(params: MessageExtensionParams): Promise<MessageExtensionResult> {
  const info = await getInfo(params.id);
  if (!info.enabled) throw new Error(`${info.name} is disabled`);
  const timeoutMs = params.timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(params.id, params.message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${info.name} did not answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { response: response ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Could not establish connection|Receiving end does not exist/i.test(msg)) {
      throw new Error(
        `${info.name} does not accept messages from other extensions: it needs a chrome.runtime.onMessageExternal listener ` +
          `(and, if it declares externally_connectable, this extension's id ${chrome.runtime.id} in its ids list)`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
