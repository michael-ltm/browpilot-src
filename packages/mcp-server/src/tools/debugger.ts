import { z } from 'zod';
import { Method, type GetEventsResult, type CdpEvent } from '@browpilot/shared';
import { defineTool, execCdp, textResult, type ToolDef, type ToolResult } from './types.js';
import type { ToolContext } from '../context.js';

interface PausedFrame {
  callFrameId?: string;
  functionName?: string;
  url?: string;
  location?: { scriptId?: string; lineNumber?: number; columnNumber?: number };
  scopeChain?: Array<{ type?: string }>;
}
interface PausedParams {
  reason?: string;
  hitBreakpoints?: string[];
  callFrames?: PausedFrame[];
}

async function latestPaused(ctx: ToolContext, tabId: number): Promise<CdpEvent | undefined> {
  const browserId = ctx.selectedBrowserId ?? undefined;
  const res = await ctx.client.request<GetEventsResult>(Method.GET_EVENTS, {
    methodPrefix: 'Debugger.paused',
    tabId,
    ...(browserId ? { browserId } : {}),
  });
  return res.events[res.events.length - 1];
}

const browser_debug = defineTool({
  name: 'browser_debug',
  description:
    'JS debugger: breakpoints, call stack, closure inspection (find where a request/sign is built). ' +
    'action "enable": Debugger.enable + subscribe ["Debugger."]. ' +
    'action "break_url": Debugger.setBreakpointByUrl {urlRegex, lineNumber, columnNumber, condition} — works for fetch-based code ' +
    '(use browser_sources search to find the line). ' +
    'action "break_xhr": DOMDebugger.setXHRBreakpoint {url substring} — XHR only, NOT fetch. ' +
    'action "break_event": DOMDebugger.setEventListenerBreakpoint {eventName} (e.g. "click"). ' +
    'action "pause"/"resume"/"step" (kind over|into|out). ' +
    'action "status": compact call stack of the latest pause {idx, fn, url, line, col, scriptId, callFrameId, scopes}. ' +
    'action "eval_frame": Debugger.evaluateOnCallFrame {callFrameId, expression} — read locals/closure at a paused frame. ' +
    'action "remove": Debugger.removeBreakpoint {breakpointId}. action "disable".',
  inputSchema: {
    action: z.enum([
      'enable', 'disable', 'break_url', 'break_xhr', 'break_event', 'remove',
      'pause', 'resume', 'step', 'status', 'eval_frame',
    ]),
    tabId: z.number().int(),
    urlRegex: z.string().optional(),
    lineNumber: z.number().int().optional(),
    columnNumber: z.number().int().optional(),
    condition: z.string().optional(),
    url: z.string().optional(),
    eventName: z.string().optional(),
    breakpointId: z.string().optional(),
    kind: z.enum(['over', 'into', 'out']).optional(),
    callFrameId: z.string().optional(),
    expression: z.string().optional(),
    maxLen: z.number().int().optional(),
  },
  async handler(args, ctx): Promise<ToolResult> {
    const { action, tabId } = args;
    await ctx.attach(tabId);
    const cdp = <R = unknown>(method: string, params: Record<string, unknown> = {}) =>
      execCdp<R>(ctx, tabId, { method, params });

    if (action === 'enable') {
      // Subscribe BEFORE enabling so the scriptParsed flood Chrome emits on
      // Debugger.enable is captured (no race). Re-enable on an already-enabled
      // target is a no-op and won't re-emit — toggle disable→enable to refresh.
      const browserId = ctx.selectedBrowserId ?? undefined;
      await ctx.client.request(Method.SUBSCRIBE_EVENTS, {
        prefixes: ['Debugger.'],
        ...(browserId ? { browserId } : {}),
      });
      await cdp('Debugger.enable');
      return textResult('debugger enabled (subscribed "Debugger." + Debugger.enable)');
    }
    if (action === 'disable') {
      await cdp('Debugger.disable');
      return textResult('debugger disabled');
    }
    if (action === 'break_url') {
      if (args.urlRegex === undefined || args.lineNumber === undefined)
        return textResult('error: break_url requires urlRegex and lineNumber');
      const out = await cdp('Debugger.setBreakpointByUrl', {
        urlRegex: args.urlRegex,
        lineNumber: args.lineNumber,
        ...(args.columnNumber !== undefined ? { columnNumber: args.columnNumber } : {}),
        ...(args.condition ? { condition: args.condition } : {}),
      });
      return textResult(JSON.stringify(out));
    }
    if (action === 'break_xhr') {
      if (!args.url) return textResult('error: break_xhr requires url');
      await cdp('DOMDebugger.setXHRBreakpoint', { url: args.url });
      return textResult(`XHR breakpoint set on "${args.url}" (note: XHR only, not fetch)`);
    }
    if (action === 'break_event') {
      if (!args.eventName) return textResult('error: break_event requires eventName');
      await cdp('DOMDebugger.setEventListenerBreakpoint', { eventName: args.eventName });
      return textResult(`event listener breakpoint set on "${args.eventName}"`);
    }
    if (action === 'remove') {
      if (!args.breakpointId) return textResult('error: remove requires breakpointId');
      await cdp('Debugger.removeBreakpoint', { breakpointId: args.breakpointId });
      return textResult(`removed breakpoint ${args.breakpointId}`);
    }
    if (action === 'pause') {
      await cdp('Debugger.pause');
      return textResult('pause requested (run "status" to read the stack once paused)');
    }
    if (action === 'resume') {
      await cdp('Debugger.resume');
      return textResult('resumed');
    }
    if (action === 'step') {
      const m = args.kind === 'into' ? 'Debugger.stepInto' : args.kind === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver';
      await cdp(m);
      return textResult(`stepped (${args.kind ?? 'over'})`);
    }
    if (action === 'status') {
      const ev = await latestPaused(ctx, tabId);
      if (!ev) return textResult('not paused (no Debugger.paused buffered)');
      const p = (ev.params ?? {}) as PausedParams;
      const stack = (p.callFrames ?? []).map((f, idx) => ({
        idx,
        fn: f.functionName || '(anonymous)',
        url: f.url,
        line: f.location?.lineNumber,
        col: f.location?.columnNumber,
        scriptId: f.location?.scriptId,
        callFrameId: f.callFrameId,
        scopes: (f.scopeChain ?? []).map((s) => s.type),
      }));
      return textResult(JSON.stringify({ reason: p.reason, hitBreakpoints: p.hitBreakpoints, at: ev.timestamp, stack }));
    }
    // action === 'eval_frame'
    if (!args.callFrameId || args.expression === undefined)
      return textResult('error: eval_frame requires callFrameId and expression');
    const out = await cdp<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Debugger.evaluateOnCallFrame', {
      callFrameId: args.callFrameId,
      expression: args.expression,
      returnByValue: true,
    });
    if (out?.exceptionDetails) {
      const d = out.exceptionDetails;
      return textResult(`eval threw: ${d.exception?.description ?? d.text ?? 'error'}`);
    }
    const maxLen = args.maxLen ?? 2000;
    let s = JSON.stringify(out?.result?.value ?? out?.result?.description ?? null);
    if (s.length > maxLen) s = `${s.slice(0, maxLen)}…(${s.length} chars)`;
    return textResult(s);
  },
});

export const debuggerTools: ToolDef[] = [browser_debug] as unknown as ToolDef[];
