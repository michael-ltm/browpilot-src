import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function loadHelpers() {
  return import('../src/background/helpers');
}

describe('helpers', () => {
  it('getTabs maps chrome.tabs.Tab into TabInfo', async () => {
    const { getTabs } = await loadHelpers();
    (mock.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, url: 'https://a.com', title: 'A', active: true, windowId: 10, pinned: false },
      { id: 2, url: 'https://b.com', title: 'B', active: false, windowId: 10, pinned: false },
    ]);
    const res = await getTabs();
    expect(res).toEqual({
      tabs: [
        { id: 1, url: 'https://a.com', title: 'A', active: true, windowId: 10 },
        { id: 2, url: 'https://b.com', title: 'B', active: false, windowId: 10 },
      ],
    });
  });

  it('newTab creates a tab and returns TabInfo', async () => {
    const { newTab } = await loadHelpers();
    (mock.chrome.tabs.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 42,
      url: 'https://x.com',
      title: 'X',
      active: true,
      windowId: 3,
    });
    const res = await newTab({ url: 'https://x.com' });
    expect(mock.chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://x.com' });
    expect(res).toEqual({ id: 42, url: 'https://x.com', title: 'X', active: true, windowId: 3 });
  });

  it('switchTab activates the tab', async () => {
    const { switchTab } = await loadHelpers();
    await switchTab({ tabId: 7 });
    expect(mock.chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
  });

  it('closeTab removes the tab', async () => {
    const { closeTab } = await loadHelpers();
    await closeTab({ tabId: 7 });
    expect(mock.chrome.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('getHistory searches and maps into HistoryEntry list with default + custom limit', async () => {
    const { getHistory } = await loadHelpers();
    (mock.chrome.history.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { url: 'https://h.com', title: 'H', lastVisitTime: 123, visitCount: 4 },
    ]);
    const res = await getHistory({ query: 'foo' });
    expect(mock.chrome.history.search).toHaveBeenCalledWith({ text: 'foo', maxResults: 100 });
    expect(res).toEqual({ entries: [{ url: 'https://h.com', title: 'H', lastVisitTime: 123, visitCount: 4 }] });
    await getHistory({ query: 'bar', limit: 5 });
    expect(mock.chrome.history.search).toHaveBeenCalledWith({ text: 'bar', maxResults: 5 });
  });
});
