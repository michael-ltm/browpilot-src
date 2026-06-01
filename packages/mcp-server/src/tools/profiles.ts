import { z } from 'zod';
import {
  Method,
  type ListProfilesResult,
  type ProfileInfo,
  type GetProfileLogsResult,
} from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';

function fmt(p: ProfileInfo): string {
  const err = p.lastError ? ` lastError="${p.lastError.message}"` : '';
  return `${p.browserId}  [${p.label}]  ${p.status}  tabs=${p.tabCount} reconnects=${p.reconnectCount}${err}`;
}

const browser_list_profiles = defineTool({
  name: 'browser_list_profiles',
  description: 'List all connected browser profiles with status. When more than one is connected and none is selected, ask the user which to use (via a native choice) then call browser_select_profile.',
  inputSchema: {},
  async handler(_args, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<ListProfilesResult>(Method.LIST_PROFILES, {});
    if (res.profiles.length === 0) return textResult('(no browser profiles connected)');
    return textResult(res.profiles.map(fmt).join('\n'));
  },
});

const browser_select_profile = defineTool({
  name: 'browser_select_profile',
  description: 'Select which connected profile this session drives, by browserId or label. Remembered for the rest of the session.',
  inputSchema: { browserId: z.string().optional(), label: z.string().optional() },
  async handler({ browserId, label }, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<ListProfilesResult>(Method.LIST_PROFILES, {});
    let resolved = browserId;
    if (!resolved && label) resolved = res.profiles.find((p) => p.label === label)?.browserId;
    const connected = resolved !== undefined && res.profiles.some((p) => p.browserId === resolved);
    if (!resolved || !connected) {
      return { ...textResult(`no connected profile matched ${browserId ?? label ?? '(nothing)'}`), isError: true };
    }
    ctx.selectedBrowserId = resolved;
    return textResult(`selected profile ${resolved}`);
  },
});

const browser_status = defineTool({
  name: 'browser_status',
  description: 'Show connection status (connected/disconnected/reconnecting), last error, reconnect count and tab count for a profile, or all profiles when none is given.',
  inputSchema: { browserId: z.string().optional() },
  async handler({ browserId }, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<{ profiles: ProfileInfo[] } | ProfileInfo | null>(
      Method.GET_PROFILE_STATUS,
      browserId ? { browserId } : {},
    );
    if (res === null) return textResult('(unknown profile)');
    const profiles = 'profiles' in res ? res.profiles : [res];
    return textResult(profiles.map(fmt).join('\n') || '(none)');
  },
});

const browser_logs = defineTool({
  name: 'browser_logs',
  description: 'Recent connect/disconnect/error/reconnect events for a profile (defaults to the selected profile).',
  inputSchema: { browserId: z.string().optional(), limit: z.number().int().positive().optional() },
  async handler({ browserId, limit }, ctx): Promise<ToolResult> {
    const bid = browserId ?? ctx.selectedBrowserId ?? undefined;
    const res = await ctx.client.request<GetProfileLogsResult>(
      Method.GET_PROFILE_LOGS,
      { ...(bid ? { browserId: bid } : {}), ...(limit ? { limit } : {}) },
    );
    if (res.events.length === 0) return textResult('(no events)');
    return textResult(res.events.map((e) => `${new Date(e.at).toISOString()}  ${e.kind}${e.detail ? '  ' + e.detail : ''}`).join('\n'));
  },
});

export const profileTools: ToolDef[] = [
  browser_list_profiles, browser_select_profile, browser_status, browser_logs,
] as unknown as ToolDef[];
