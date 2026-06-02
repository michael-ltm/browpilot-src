import { z } from 'zod';
import { defineTool, execCdp, textResult, type ToolDef, type ToolResult } from './types.js';
import type { ToolContext } from '../context.js';

// Injectable sleep so browser_wait({ms}) is deterministic in tests.
let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
export function __setSleep(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

interface NavHistory {
  currentIndex: number;
  entries: Array<{ id: number }>;
}

async function navigateRelative(ctx: ToolContext, tabId: number, delta: number): Promise<boolean> {
  const hist = await execCdp<NavHistory>(ctx, tabId, {
    method: 'Page.getNavigationHistory',
    params: {},
  });
  const target = hist.currentIndex + delta;
  if (target < 0 || target >= hist.entries.length) return false;
  await execCdp(ctx, tabId, {
    method: 'Page.navigateToHistoryEntry',
    params: { entryId: hist.entries[target]!.id },
  });
  return true;
}

const browser_navigate = defineTool({
  name: 'browser_navigate',
  description: 'Navigate the tab to a URL (Page.navigate).',
  inputSchema: { url: z.string().url(), tabId: z.number().int() },
  async handler({ url, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, { method: 'Page.navigate', params: { url } });
    return textResult(`navigated to ${url}`);
  },
});

const browser_back = defineTool({
  name: 'browser_back',
  description: 'Go back one entry in the tab history.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const ok = await navigateRelative(ctx, tabId, -1);
    return textResult(ok ? 'went back' : 'no previous history entry');
  },
});

const browser_forward = defineTool({
  name: 'browser_forward',
  description: 'Go forward one entry in the tab history.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const ok = await navigateRelative(ctx, tabId, 1);
    return textResult(ok ? 'went forward' : 'no next history entry');
  },
});

const browser_reload = defineTool({
  name: 'browser_reload',
  description: 'Reload the tab (Page.reload).',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, { method: 'Page.reload', params: {} });
    return textResult('reloaded');
  },
});

const browser_wait = defineTool({
  name: 'browser_wait',
  description: 'Wait for a fixed time (ms) or until a CSS selector exists (selector). Polls every 200ms up to ~10s.',
  inputSchema: {
    ms: z.number().int().positive().optional(),
    selector: z.string().optional(),
    tabId: z.number().int(),
  },
  async handler({ ms, selector, tabId }, ctx): Promise<ToolResult> {
    if (ms !== undefined) {
      await sleep(ms);
      return textResult(`waited ${ms}ms`);
    }
    if (selector !== undefined) {
      await ctx.attach(tabId);
      const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
      const deadline = 10_000;
      const interval = 200;
      let waited = 0;
      for (;;) {
        const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        });
        if (out.result?.value === true) return textResult(`selector ${selector} appeared`);
        if (waited >= deadline) return textResult(`timed out waiting for ${selector}`);
        await sleep(interval);
        waited += interval;
      }
    }
    return textResult('nothing to wait for');
  },
});

export const navigationTools: ToolDef[] = [
  browser_navigate,
  browser_back,
  browser_forward,
  browser_reload,
  browser_wait,
] as unknown as ToolDef[];
