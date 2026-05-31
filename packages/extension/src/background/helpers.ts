import {
  type GetTabsResult,
  type TabInfo,
  type NewTabParams,
  type NewTabResult,
  type SwitchTabParams,
  type CloseTabParams,
  type GetHistoryParams,
  type GetHistoryResult,
  type HistoryEntry,
} from '@claude-browser/shared';

const DEFAULT_HISTORY_LIMIT = 100;

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id ?? -1,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
  };
}

export async function getTabs(): Promise<GetTabsResult> {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.map(toTabInfo) };
}

export async function newTab(params: NewTabParams): Promise<NewTabResult> {
  const tab = await chrome.tabs.create({ url: params.url });
  return toTabInfo(tab);
}

export async function switchTab(params: SwitchTabParams): Promise<Record<string, never>> {
  await chrome.tabs.update(params.tabId, { active: true });
  return {};
}

export async function closeTab(params: CloseTabParams): Promise<Record<string, never>> {
  await chrome.tabs.remove(params.tabId);
  return {};
}

export async function getHistory(params: GetHistoryParams): Promise<GetHistoryResult> {
  const items = await chrome.history.search({
    text: params.query,
    maxResults: params.limit ?? DEFAULT_HISTORY_LIMIT,
  });
  const entries: HistoryEntry[] = items.map((i) => ({
    url: i.url ?? '',
    title: i.title,
    lastVisitTime: i.lastVisitTime,
    visitCount: i.visitCount,
  }));
  return { entries };
}
