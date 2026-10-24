import { Method } from '@browpilot/shared';
import type { Transport } from './transport';

export function pairingNonce(url: string | undefined, extensionId: string): string | null {
  const prefix = `chrome-extension://${extensionId}/pair.html#`;
  if (!url?.startsWith(prefix)) return null;
  const nonce = url.slice(prefix.length);
  return /^[A-Za-z0-9_-]{32}$/.test(nonce) ? nonce : null;
}

/**
 * Send from the pairing page, retrying while the service worker has not
 * registered its listener yet (cold start runs async setup first, and Chrome
 * reports that window as "Receiving end does not exist").
 */
export async function sendUntilReceived<T>(send: () => Promise<T>, deadlineMs = 10_000, delayMs = 250, now: () => number = Date.now): Promise<T> {
  const deadline = now() + deadlineMs;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      if (!/Receiving end does not exist/i.test(String((error as Error)?.message)) || now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

export async function pairRequest(message: { nonce?: unknown; type?: string }, sender: { id?: string; url?: string }, extensionId: string, send: (nonce: string) => Promise<unknown>) {
  if (sender.id !== extensionId || sender.url?.split(/[?#]/)[0] !== `chrome-extension://${extensionId}/pair.html`) throw new Error('Pairing is allowed only from our pairing page');
  if (typeof message.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(message.nonce)) throw new Error('Invalid pairing nonce');
  return send(message.nonce);
}

export function registerPairing(transport: Transport): void {
  const attempted = new Set<string>();
  const remember = (nonce: string) => {
    attempted.add(nonce);
    if (attempted.size > 128) attempted.delete(attempted.values().next().value!);
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'browpilot-pair') return false;
    void pairRequest(message, sender, chrome.runtime.id, async nonce => {
      remember(nonce);
      const deadline = Date.now() + 12_000;
      transport.connect();
      while (!transport.isConnected() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (!transport.isConnected()) throw new Error('Browpilot broker is not connected');
      return transport.sendRequest(Method.PAIR_LOCAL_PROFILE, { nonce });
    }).then(respond, error => respond({ paired: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
  // At browser cold start, the initial extension URL can finish as ERR_BLOCKED_BY_CLIENT
  // before extensions load. Navigate from our extension origin rather than reload
  // the blocked document, which can retain its original navigation restrictions.
  // Restore only our nonce-bearing entry page, once per nonce.
  const recover = (tab: chrome.tabs.Tab) => {
    const nonce = pairingNonce(tab.url, chrome.runtime.id);
    if (!nonce || tab.id === undefined || tab.status !== 'complete' || attempted.has(nonce)) return;
    remember(nonce);
    void chrome.tabs.update(tab.id, { url: tab.url }).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.status === 'complete') recover(tab); });
  void chrome.tabs.query({}).then(tabs => tabs.forEach(recover)).catch(() => {});
}
