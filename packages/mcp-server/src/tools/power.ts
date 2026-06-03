import { z } from 'zod';
import { Method, type SubscribeEventsResult, type GetEventsResult } from '@claude-browser/shared';
import { defineTool, execCdp, textResult, type ToolDef, type ToolResult } from './types.js';

const browser_cdp = defineTool({
  name: 'browser_cdp',
  description:
    'DANGER: send a raw Chrome DevTools Protocol command to a tab and return its JSON result. ' +
    'Unlocks every CDP domain — Network, Debugger, DOMDebugger, Page, Runtime, Storage, Target, ' +
    'Profiler, Fetch, Emulation, etc. Examples: {"method":"Network.enable"}, ' +
    '{"method":"Debugger.getScriptSource","params":{"scriptId":"42"}}, ' +
    '{"method":"Storage.getCookies"}, {"method":"Target.getTargets"}. ' +
    'Permission-gated; only use with explicit user intent.',
  inputSchema: {
    method: z.string(),
    params: z.record(z.unknown()).optional(),
    tabId: z.number().int(),
  },
  async handler({ method, params, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const out = await execCdp(ctx, tabId, { method, params: params ?? {} });
    return textResult(JSON.stringify(out ?? null));
  },
});

const DEFAULT_MAX_LEN = 2000;
const MAX_ARRAY = 60;

/** Deep-copy an event, truncating long strings and capping arrays so a single
 *  huge WebSocket frame / response body can't blow up the agent's context.
 *  Each truncated string keeps a `…(<N> chars)` marker with the original length. */
function clamp(value: unknown, maxLen: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…(${value.length} chars)` : value;
  }
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => clamp(v, maxLen));
    if (value.length > MAX_ARRAY) arr.push(`…(${value.length - MAX_ARRAY} more)` as unknown);
    return arr;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = clamp((value as Record<string, unknown>)[k], maxLen);
    }
    return out;
  }
  return value;
}

const browser_events = defineTool({
  name: 'browser_events',
  description:
    'Subscribe to and read buffered CDP events (Network.*, Debugger.*, Target.*, Page.*, ...). ' +
    'action "subscribe": set method prefixes to buffer, e.g. {"action":"subscribe","prefixes":["Network.","Debugger."]} ' +
    '— enable the domain first via browser_cdp (e.g. Network.enable). ' +
    'action "poll": read buffered events with optional methodPrefix/tabId/since/limit filters (since = last ' +
    'event timestamp, for incremental reads). Long strings (e.g. WebSocket frame payloads, response bodies) are ' +
    'truncated to maxLen chars (default 2000) with a length marker; pass raw=true for untruncated, or raise maxLen. ' +
    'action "clear": empty the buffer.',
  inputSchema: {
    action: z.enum(['subscribe', 'poll', 'clear']),
    prefixes: z.array(z.string()).optional(),
    methodPrefix: z.string().optional(),
    tabId: z.number().int().optional(),
    since: z.number().optional(),
    limit: z.number().int().optional(),
    clear: z.boolean().optional(),
    maxLen: z.number().int().optional(),
    raw: z.boolean().optional(),
  },
  async handler(args, ctx): Promise<ToolResult> {
    const browserId = ctx.selectedBrowserId ?? undefined;
    if (args.action === 'subscribe') {
      const res = await ctx.client.request<SubscribeEventsResult>(Method.SUBSCRIBE_EVENTS, {
        prefixes: args.prefixes ?? [],
        ...(browserId ? { browserId } : {}),
      });
      return textResult(`subscribed prefixes: ${JSON.stringify(res.prefixes)}`);
    }
    const res = await ctx.client.request<GetEventsResult>(Method.GET_EVENTS, {
      methodPrefix: args.methodPrefix,
      tabId: args.tabId,
      since: args.since,
      limit: args.limit,
      clear: args.action === 'clear' ? true : args.clear ?? false,
      ...(browserId ? { browserId } : {}),
    });
    if (args.action === 'clear') return textResult('cleared');
    const events = args.raw ? res.events : clamp(res.events, args.maxLen ?? DEFAULT_MAX_LEN);
    return textResult(JSON.stringify(events));
  },
});

export const powerTools: ToolDef[] = [browser_cdp, browser_events] as unknown as ToolDef[];
