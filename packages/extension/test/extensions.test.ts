import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';

let mock: ChromeMock;
let installed: Record<string, chrome.management.ExtensionInfo>;

const ext = (id: string, over: Partial<chrome.management.ExtensionInfo> = {}) =>
  ({ id, name: `Ext ${id}`, version: '1.0', enabled: true, installType: 'development', type: 'extension', optionsUrl: '', description: '', mayDisable: true, ...over }) as chrome.management.ExtensionInfo;

beforeEach(() => {
  mock = installChromeMock();
  installed = {
    a: ext('a', { name: 'DP 转发助手', optionsUrl: 'chrome-extension://a/options/options.html' }),
    p: ext('p', { name: 'Policy', installType: 'admin', mayDisable: false }),
    t: ext('t', { type: 'theme' }),
    testextensionid: ext('testextensionid', { name: 'Browpilot' }),
  };
  const c = mock.chrome as unknown as Record<string, unknown>;
  c.management = {
    getAll: vi.fn(async () => Object.values(installed)),
    get: vi.fn(async (id: string) => {
      if (!installed[id]) throw new Error('Failed to find extension');
      return { ...installed[id] };
    }),
    setEnabled: vi.fn(async (id: string, enabled: boolean) => {
      installed[id]!.enabled = enabled;
    }),
  };
  (c.tabs as Record<string, unknown>).create = vi.fn(async ({ url }: { url: string }) => ({ id: 7, url }));
  (c.runtime as Record<string, unknown>).sendMessage = vi.fn();
  (c.runtime as Record<string, unknown>).reload = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const load = () => import('../src/background/extensions');

describe('extensions', () => {
  it('lists extensions without themes and marks Browpilot itself', async () => {
    const { listExtensions } = await load();
    const { extensions } = await listExtensions();
    expect(extensions.map((e) => e.id)).toEqual(['a', 'p', 'testextensionid']);
    expect(extensions[0]).toMatchObject({ name: 'DP 转发助手', optionsUrl: 'chrome-extension://a/options/options.html', isSelf: false });
    expect(extensions[2]!.isSelf).toBe(true);
  });

  it('reload toggles the extension off and on', async () => {
    const { manageExtension } = await load();
    const res = await manageExtension({ id: 'a', action: 'reload' });
    const setEnabled = (mock.chrome as unknown as { management: { setEnabled: ReturnType<typeof vi.fn> } }).management.setEnabled;
    expect(setEnabled.mock.calls).toEqual([['a', false], ['a', true]]);
    expect(res.extension?.enabled).toBe(true);
  });

  it('refuses to toggle policy-managed extensions and unknown ids', async () => {
    const { manageExtension } = await load();
    await expect(manageExtension({ id: 'p', action: 'disable' })).rejects.toThrow(/managed by policy/);
    await expect(manageExtension({ id: 'zz', action: 'reload' })).rejects.toThrow(/not installed/);
  });

  it('reloading Browpilot itself answers first, then calls runtime.reload', async () => {
    vi.useFakeTimers();
    const { manageExtension } = await load();
    const res = await manageExtension({ id: 'testextensionid', action: 'reload' });
    expect(res.detail).toMatch(/reloading/);
    const reload = mock.chrome.runtime.reload as unknown as ReturnType<typeof vi.fn>;
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(reload).toHaveBeenCalled();
    await expect(manageExtension({ id: 'testextensionid', action: 'disable' })).rejects.toThrow(/Browpilot itself/);
  });

  it('open_options opens the options page in a tab', async () => {
    const { manageExtension } = await load();
    expect(await manageExtension({ id: 'a', action: 'open_options' })).toMatchObject({ tabId: 7 });
    await expect(manageExtension({ id: 'p', action: 'open_options' })).rejects.toThrow(/no options page/);
  });

  it('message returns the reply and explains a missing onMessageExternal listener', async () => {
    const { messageExtension } = await load();
    const send = mock.chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    send.mockResolvedValueOnce({ success: true, data: 1 });
    expect(await messageExtension({ id: 'a', message: { type: 'PING' } })).toEqual({ response: { success: true, data: 1 } });
    expect(send).toHaveBeenCalledWith('a', { type: 'PING' });
    send.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    await expect(messageExtension({ id: 'a', message: {} })).rejects.toThrow(/onMessageExternal/);
  });

  it('message times out', async () => {
    const { messageExtension } = await load();
    (mock.chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {}));
    await expect(messageExtension({ id: 'a', message: {}, timeoutMs: 50 })).rejects.toThrow(/did not answer within 50ms/);
  });
});
