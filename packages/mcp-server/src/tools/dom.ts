import { z } from 'zod';
import { ErrorCode } from '@claude-browser/shared';
import { clickEvents, insertTextCmd, boxCenter } from '../cdp.js';
import { compactAxTree, type AxTree } from '../snapshot.js';
import {
  defineTool,
  execCdp,
  execCdpSeq,
  textResult,
  type ToolDef,
  type ToolResult,
} from './types.js';
import type { ToolContext } from '../context.js';

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Resolve a snapshot ref to its backendDOMNodeId or throw a stale-ref error. */
function resolveRef(ctx: ToolContext, ref: string): number {
  const id = ctx.refs.get(ref);
  if (id === undefined) {
    throw new RefError(`stale or unknown ref "${ref}" — re-run browser_snapshot`);
  }
  return id;
}

class RefError extends Error {
  code = ErrorCode.STALE_REF;
}

const browser_snapshot = defineTool({
  name: 'browser_snapshot',
  description: 'Accessibility snapshot of the page as a compact list of elements with stable [refN] handles for browser_click_ref/browser_fill.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const tree = await execCdp<AxTree>(ctx, tabId, {
      method: 'Accessibility.getFullAXTree',
      params: {},
    });
    const { refs, outline } = compactAxTree(tree);
    ctx.refs.clear();
    for (const [k, v] of refs) ctx.refs.set(k, v);
    return textResult(outline || '(no accessible elements)');
  },
});

const browser_click_ref = defineTool({
  name: 'browser_click_ref',
  description: 'Click an element by its snapshot [refN] handle (resolved via DOM.getBoxModel center).',
  inputSchema: { ref: z.string(), tabId: z.number().int() },
  async handler({ ref, tabId }, ctx): Promise<ToolResult> {
    let backendNodeId: number;
    try {
      backendNodeId = resolveRef(ctx, ref);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    await ctx.attach(tabId);
    const box = await execCdp<{ model: { content: number[] } }>(ctx, tabId, {
      method: 'DOM.getBoxModel',
      params: { backendNodeId },
    });
    const { x, y } = boxCenter(box.model.content);
    await execCdpSeq(ctx, tabId, clickEvents(x, y, 'left', 1));
    return textResult(`clicked ${ref} at (${x}, ${y})`);
  },
});

const browser_fill = defineTool({
  name: 'browser_fill',
  description: 'Focus an element by its [refN] handle and type a value into it.',
  inputSchema: { ref: z.string(), value: z.string(), tabId: z.number().int() },
  async handler({ ref, value, tabId }, ctx): Promise<ToolResult> {
    let backendNodeId: number;
    try {
      backendNodeId = resolveRef(ctx, ref);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, { method: 'DOM.focus', params: { backendNodeId } });
    await execCdp(ctx, tabId, insertTextCmd(value));
    return textResult(`filled ${ref}`);
  },
});

const browser_query = defineTool({
  name: 'browser_query',
  description: 'Find elements by CSS selector. Returns matched outerHTML (first match, or all when all=true).',
  inputSchema: { selector: z.string(), all: z.boolean().optional(), tabId: z.number().int() },
  async handler({ selector, all, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const sel = JSON.stringify(selector);
    const expression = all
      ? `JSON.stringify(Array.from(document.querySelectorAll(${sel})).map(e => e.outerHTML))`
      : `(() => { const el = document.querySelector(${sel}); return el ? el.outerHTML : null; })()`;
    const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    });
    return textResult(String(out.result?.value ?? 'null'));
  },
});

const browser_get_text = defineTool({
  name: 'browser_get_text',
  description: 'Get readable innerText of a CSS selector, or the whole body when selector is omitted.',
  inputSchema: { selector: z.string().optional(), tabId: z.number().int() },
  async handler({ selector, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const target = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body';
    const expression = `(() => { const el = ${target}; return el ? el.innerText : null; })()`;
    const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    });
    return textResult(String(out.result?.value ?? ''));
  },
});

const browser_eval = defineTool({
  name: 'browser_eval',
  description: 'DANGER: runs arbitrary JavaScript in the page via Runtime.evaluate and returns the value. Permission-gated; only use with explicit user intent.',
  inputSchema: { expression: z.string(), tabId: z.number().int() },
  async handler({ expression, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const out = await execCdp<{
      result: { value: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(ctx, tabId, {
      method: 'Runtime.evaluate',
      // awaitPromise: resolve async expressions instead of returning the bare Promise
      // (which serializes to {}). returnByValue: deep-copy the result out of the page.
      params: { expression, returnByValue: true, awaitPromise: true },
    });
    if (out.exceptionDetails) {
      const { exception, text } = out.exceptionDetails;
      return errorResult(exception?.description ?? text ?? 'evaluation threw');
    }
    return textResult(JSON.stringify(out.result?.value ?? null));
  },
});

export const domTools: ToolDef[] = [
  browser_snapshot,
  browser_click_ref,
  browser_fill,
  browser_query,
  browser_get_text,
  browser_eval,
] as unknown as ToolDef[];
