import { z } from 'zod';
import { Method, type GetConsoleParams, type GetConsoleResult } from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';
import { profileParam } from '../context.js';

const browser_console = defineTool({
  name: 'browser_console',
  description: 'Read buffered browser console messages from the broker. Filter by tab, level substring, or timestamp.',
  inputSchema: {
    tabId: z.number().int().optional(),
    filter: z.string().optional(),
    since: z.number().optional(),
    profile: z.string().optional(),
  },
  async handler({ tabId, filter, since, profile }, ctx): Promise<ToolResult> {
    const params: GetConsoleParams = { tabId, filter, since, ...profileParam(ctx, profile) };
    const res = await ctx.client.request<GetConsoleResult>(Method.GET_CONSOLE, params);
    const lines = res.entries.map(
      (e) => `[${new Date(e.timestamp).toISOString()}] ${e.level} (tab ${e.tabId}): ${e.text}`,
    );
    return textResult(lines.join('\n') || '(no console entries)');
  },
});

export const consoleTools: ToolDef[] = [browser_console] as unknown as ToolDef[];
