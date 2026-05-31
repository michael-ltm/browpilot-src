import { z } from 'zod';
import {
  Method,
  type GetTabsResult,
  type NewTabParams,
  type NewTabResult,
  type SwitchTabParams,
  type CloseTabParams,
} from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';

const browser_get_tabs = defineTool({
  name: 'browser_get_tabs',
  description: 'List open browser tabs (id, url, title, active).',
  inputSchema: {},
  async handler(_args, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<GetTabsResult>(Method.GET_TABS, {});
    const lines = res.tabs.map(
      (t) => `${t.id}${t.active ? ' *' : ''}: ${t.title ?? '(untitled)'} — ${t.url ?? ''}`,
    );
    return textResult(lines.join('\n') || '(no tabs)');
  },
});

const browser_new_tab = defineTool({
  name: 'browser_new_tab',
  description: 'Open a new tab, optionally at a URL. Returns the new tab id.',
  inputSchema: { url: z.string().url().optional() },
  async handler({ url }, ctx): Promise<ToolResult> {
    const params: NewTabParams = { url };
    const tab = await ctx.client.request<NewTabResult>(Method.NEW_TAB, params);
    return textResult(`opened tab ${tab.id}${tab.url ? ` at ${tab.url}` : ''}`);
  },
});

const browser_switch_tab = defineTool({
  name: 'browser_switch_tab',
  description: 'Activate (focus) a tab by id.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    const params: SwitchTabParams = { tabId };
    await ctx.client.request(Method.SWITCH_TAB, params);
    return textResult(`switched to tab ${tabId}`);
  },
});

const browser_close_tab = defineTool({
  name: 'browser_close_tab',
  description: 'Close a tab by id.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    const params: CloseTabParams = { tabId };
    await ctx.client.request(Method.CLOSE_TAB, params);
    return textResult(`closed tab ${tabId}`);
  },
});

export const tabsTools: ToolDef[] = [
  browser_get_tabs,
  browser_new_tab,
  browser_switch_tab,
  browser_close_tab,
] as unknown as ToolDef[];
