import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';
import { Notif } from '@claude-browser/shared';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function loadRelay() {
  return import('../src/background/relay');
}

describe('relay', () => {
  it('handleExecuteCdp forwards to chrome.debugger.sendCommand and returns the result', async () => {
    const { handleExecuteCdp } = await loadRelay();
    mock.sendCommandImpl = async (_t, method) => {
      expect(method).toBe('Page.navigate');
      return { frameId: 'f1' };
    };
    const result = await handleExecuteCdp({
      target: { tabId: 5 },
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
    expect(result).toEqual({ frameId: 'f1' });
    expect(mock.chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 5 },
      'Page.navigate',
      { url: 'https://example.com' },
    );
  });

  it('attach attaches at 1.3, overrides device metrics with scale 1, and enables Runtime+Log', async () => {
    const { attach } = await loadRelay();
    const calls: string[] = [];
    mock.sendCommandImpl = async (_t, method, params) => {
      calls.push(method);
      if (method === 'Emulation.setDeviceMetricsOverride') {
        expect(params).toMatchObject({ deviceScaleFactor: 1, mobile: false });
      }
      return {};
    };
    await attach({ tabId: 7 });
    expect(mock.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(calls).toContain('Emulation.setDeviceMetricsOverride');
    expect(calls).toContain('Runtime.enable');
    expect(calls).toContain('Log.enable');
  });

  it('attach tolerates an already-attached error and still configures the target', async () => {
    const { attach } = await loadRelay();
    (mock.chrome.debugger.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Another debugger is already attached to the tab with id: 7.'),
    );
    const calls: string[] = [];
    mock.sendCommandImpl = async (_t, method) => {
      calls.push(method);
      return {};
    };
    await attach({ tabId: 7 });
    expect(calls).toContain('Emulation.setDeviceMetricsOverride');
    expect(calls).toContain('Runtime.enable');
    expect(calls).toContain('Log.enable');
  });

  it('attach rethrows a non-already-attached error', async () => {
    const { attach } = await loadRelay();
    (mock.chrome.debugger.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Cannot access a chrome:// URL'),
    );
    await expect(attach({ tabId: 7 })).rejects.toThrow(/chrome:\/\//);
  });

  it('forwards chrome.debugger.onEvent as an ON_CDP_EVENT notification', async () => {
    const { registerCdpEventForwarding } = await loadRelay();
    const sent: Array<{ method: string; params: unknown }> = [];
    const transport = { sendNotification: (method: string, params: unknown) => sent.push({ method, params }) };
    registerCdpEventForwarding(transport);
    mock.emitDebuggerEvent({ tabId: 5 }, 'Runtime.consoleAPICalled', { type: 'log' });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe(Notif.ON_CDP_EVENT);
    expect(sent[0].params).toEqual({
      source: { tabId: 5 },
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
    });
  });

  it('auto-reattaches on a non-canceled onDetach', async () => {
    const { registerAutoReattach } = await loadRelay();
    mock.sendCommandImpl = async () => ({});
    registerAutoReattach();
    mock.emitDetach({ tabId: 9 }, 'target_closed_unexpectedly');
    await vi.waitFor(() => expect(mock.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3'));
  });

  it('does NOT reattach when the user canceled the debugger', async () => {
    const { registerAutoReattach } = await loadRelay();
    registerAutoReattach();
    mock.emitDetach({ tabId: 9 }, 'canceled_by_user');
    await new Promise((r) => setTimeout(r, 5));
    expect(mock.chrome.debugger.attach).not.toHaveBeenCalled();
  });
});
