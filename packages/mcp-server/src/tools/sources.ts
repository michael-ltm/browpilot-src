import { z } from 'zod';
import { Method, type GetEventsResult, type CdpEvent } from '@browpilot/shared';
import { defineTool, execCdp, textResult, type ToolDef, type ToolResult } from './types.js';
import type { ToolContext } from '../context.js';

interface ScriptParsed {
  scriptId?: string;
  url?: string;
  length?: number;
}

async function getEvents(ctx: ToolContext, methodPrefix: string, tabId: number): Promise<CdpEvent[]> {
  const browserId = ctx.selectedBrowserId ?? undefined;
  const res = await ctx.client.request<GetEventsResult>(Method.GET_EVENTS, {
    methodPrefix,
    tabId,
    ...(browserId ? { browserId } : {}),
  });
  return res.events;
}

const browser_sources = defineTool({
  name: 'browser_sources',
  description:
    'Inspect loaded JS source (great for webpack/minified/obfuscated bundles). Run browser_debug enable first so ' +
    'Debugger.scriptParsed events are buffered. ' +
    'action "list": parsed scripts {scriptId, url, length} (filter urlPattern, last `limit`). ' +
    'action "get": a slice of a script via Debugger.getScriptSource {scriptId, start, length} — never returns the whole multi-MB file. ' +
    'action "search": find a string/regex inside one script and return only ±context snippets {index, snippet} (default max 20 hits) — ' +
    'the full source stays in the server, out of the agent context.',
  inputSchema: {
    action: z.enum(['list', 'get', 'search']),
    tabId: z.number().int(),
    scriptId: z.string().optional(),
    urlPattern: z.string().optional(),
    start: z.number().int().optional(),
    length: z.number().int().optional(),
    query: z.string().optional(),
    isRegex: z.boolean().optional(),
    context: z.number().int().optional(),
    max: z.number().int().optional(),
    limit: z.number().int().optional(),
  },
  async handler(args, ctx): Promise<ToolResult> {
    const { action, tabId } = args;

    if (action === 'list') {
      const parsed = await getEvents(ctx, 'Debugger.scriptParsed', tabId);
      const seen = new Map<string, { scriptId: string; url: string; length?: number }>();
      for (const e of parsed) {
        const p = (e.params ?? {}) as ScriptParsed;
        if (p.scriptId) seen.set(p.scriptId, { scriptId: p.scriptId, url: p.url ?? '', length: p.length });
      }
      let rows = [...seen.values()];
      if (args.urlPattern) rows = rows.filter((r) => r.url.includes(args.urlPattern!));
      rows.sort((a, b) => (b.length ?? 0) - (a.length ?? 0));
      return textResult(JSON.stringify(rows.slice(0, args.limit ?? 100)));
    }

    if (!args.scriptId) return textResult('error: scriptId required (get it from action "list")');
    await ctx.attach(tabId);
    const src = await execCdp<{ scriptSource: string }>(ctx, tabId, {
      method: 'Debugger.getScriptSource',
      params: { scriptId: args.scriptId },
    });
    const source = src?.scriptSource ?? '';

    if (action === 'get') {
      const start = Math.max(0, args.start ?? 0);
      const length = args.length ?? 4000;
      return textResult(
        JSON.stringify({
          scriptId: args.scriptId,
          totalLength: source.length,
          start,
          slice: source.slice(start, start + length),
        }),
      );
    }

    // action === 'search'
    if (!args.query) return textResult('error: query required for action "search"');
    const ctxLen = args.context ?? 120;
    const max = args.max ?? 20;
    const hits: Array<{ index: number; snippet: string }> = [];
    if (args.isRegex) {
      const re = new RegExp(args.query, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null && hits.length < max) {
        const i = m.index;
        hits.push({ index: i, snippet: source.slice(Math.max(0, i - ctxLen), i + m[0].length + ctxLen) });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    } else {
      let from = 0;
      for (;;) {
        const i = source.indexOf(args.query, from);
        if (i === -1 || hits.length >= max) break;
        hits.push({ index: i, snippet: source.slice(Math.max(0, i - ctxLen), i + args.query.length + ctxLen) });
        from = i + args.query.length;
      }
    }
    return textResult(
      JSON.stringify({ scriptId: args.scriptId, totalLength: source.length, hitCount: hits.length, hits }),
    );
  },
});

export const sourcesTools: ToolDef[] = [browser_sources] as unknown as ToolDef[];
