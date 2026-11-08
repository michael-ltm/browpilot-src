import { z } from 'zod';
import {
  clickEvents,
  hoverEvent,
  keyEvents,
  typeEvents,
  insertTextCmd,
  modifierBits,
  withModifiers,
  type MouseButton,
} from '../cdp.js';
import { compactAxTree, type AxTree } from '../snapshot.js';
import {
  defineTool,
  execCdp,
  execCdpSeq,
  textResult,
  type ToolDef,
  type ToolResult,
} from './types.js';
import {
  ActionError,
  RefError,
  focusState,
  inspect,
  locate,
  resolveObject,
  resolveRef,
  selectOption,
  setNativeValue,
} from './element.js';
import type { ToolContext } from '../context.js';

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Run an element action, turning stale refs and actionability failures into tool errors. */
async function withElement(
  ctx: ToolContext,
  ref: string,
  tabId: number,
  action: (objectId: string, backendNodeId: number) => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    const backendNodeId = resolveRef(ctx, ref);
    await ctx.attach(tabId);
    const objectId = await resolveObject(ctx, tabId, backendNodeId);
    return await action(objectId, backendNodeId);
  } catch (e) {
    if (e instanceof RefError || e instanceof ActionError) return errorResult(`${ref}: ${e.message}`);
    throw e;
  }
}

/** Above this length fill pastes (Input.insertText) instead of typing key by key. */
const TYPE_LIMIT = 2000;

const TRUE_WORDS = ['true', 'checked', 'on', 'yes', '1'];
const FALSE_WORDS = ['false', 'unchecked', 'off', 'no', '0'];

const browser_snapshot = defineTool({
  name: 'browser_snapshot',
  description: 'Accessibility snapshot of the page as a compact list of elements with stable [refN] handles for browser_click_ref/browser_hover_ref/browser_fill.',
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
  description:
    'Click an element by its snapshot [refN] handle with real mouse input, like a user: scrolls it into view, waits for it to stop moving, ' +
    'checks nothing covers it, then moves the pointer there and presses/releases (hover, pointerdown, mousedown, focus, mouseup, click). ' +
    'Errors if an overlay covers it (force:true clicks anyway). count:2 double-clicks; modifiers e.g. ["Control"] holds keys during the click. ' +
    'A ref to a native <option> selects it.',
  inputSchema: {
    ref: z.string(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
    force: z.boolean().optional().describe('Click even if another element covers the target.'),
    tabId: z.number().int(),
  },
  async handler({ ref, button, count, modifiers, force, tabId }, ctx): Promise<ToolResult> {
    return withElement(ctx, ref, tabId, async (objectId, backendNodeId) => {
      const info = await inspect(ctx, tabId, objectId);
      if (info.kind === 'option') {
        return textResult(`selected ${await selectOption(ctx, tabId, objectId)}`);
      }
      const { x, y } = await locate(ctx, tabId, objectId, backendNodeId, { force });
      const btn: MouseButton = button ?? 'left';
      await execCdpSeq(
        ctx,
        tabId,
        withModifiers(modifierBits(modifiers ?? []), (m) => clickEvents(x, y, btn, count ?? 1, m)),
      );
      return textResult(`clicked ${ref} at (${Math.round(x)}, ${Math.round(y)})`);
    });
  },
});

const browser_hover_ref = defineTool({
  name: 'browser_hover_ref',
  description: 'Move the real mouse pointer over an element by its [refN] handle (scrolls it into view first), firing pointerover/mouseover/mouseenter — opens hover menus and tooltips.',
  inputSchema: { ref: z.string(), force: z.boolean().optional(), tabId: z.number().int() },
  async handler({ ref, force, tabId }, ctx): Promise<ToolResult> {
    return withElement(ctx, ref, tabId, async (objectId, backendNodeId) => {
      const { x, y } = await locate(ctx, tabId, objectId, backendNodeId, { force });
      await execCdp(ctx, tabId, hoverEvent(x, y));
      return textResult(`hovering ${ref} at (${Math.round(x)}, ${Math.round(y)})`);
    });
  },
});

const browser_fill = defineTool({
  name: 'browser_fill',
  description:
    'Set a form control (by its [refN] handle) to a value the way a user would, so React/Vue state updates. ' +
    'Text inputs, textareas and contenteditable editors: clicks into it, selects all (Ctrl/Cmd+A), deletes, then types the value key by key ' +
    '(keydown/keypress/beforeinput/input/keyup per character; Chinese and other non-keyboard text goes through IME composition events). ' +
    'Replaces existing content; use browser_type to append. Does not blur — press Tab afterwards if the page validates on blur/change. ' +
    'Native <select>: value or visible label of the option. Checkbox/radio: "true"/"false" (clicks only if the state differs). ' +
    'date/time/month/week/color/range inputs: the input\'s value format, e.g. 2024-05-31. File inputs: absolute file path(s), one per line.',
  inputSchema: { ref: z.string(), value: z.string(), tabId: z.number().int() },
  async handler({ ref, value, tabId }, ctx): Promise<ToolResult> {
    return withElement(ctx, ref, tabId, async (objectId, backendNodeId) => {
      const info = await inspect(ctx, tabId, objectId);
      if (info.disabled) return errorResult(`${ref}: element is disabled`);

      switch (info.kind) {
        case 'select':
        case 'option':
          return textResult(`selected ${await selectOption(ctx, tabId, objectId, value)} in ${ref}`);

        case 'toggle': {
          const v = value.trim().toLowerCase();
          const want = TRUE_WORDS.includes(v) ? true : FALSE_WORDS.includes(v) ? false : null;
          if (want === null) return errorResult(`${ref}: a ${info.type} takes "true" or "false", got "${value}"`);
          if (info.checked !== want) {
            if (!want && info.type === 'radio') {
              return errorResult(`${ref}: a radio button cannot be unchecked directly — check another option in its group`);
            }
            const { x, y } = await locate(ctx, tabId, objectId, backendNodeId);
            await execCdpSeq(ctx, tabId, clickEvents(x, y));
          }
          const now = (await inspect(ctx, tabId, objectId)).checked;
          return now === want
            ? textResult(`${ref} is ${now ? 'checked' : 'unchecked'}`)
            : errorResult(`${ref}: clicked, but it is still ${now ? 'checked' : 'unchecked'} (the page may have prevented it)`);
        }

        case 'value':
          return textResult(`set ${ref} to "${await setNativeValue(ctx, tabId, objectId, value)}"`);

        case 'file': {
          const files = value.split('\n').map((f) => f.trim()).filter(Boolean);
          await execCdp(ctx, tabId, { method: 'DOM.setFileInputFiles', params: { files, objectId } });
          return textResult(`attached ${files.length} file(s) to ${ref}`);
        }

        default:
          return fillText(ctx, tabId, ref, objectId, backendNodeId, info.multiline ? value : value.replace(/\r?\n/g, ''));
      }
    });
  },
});

/** Click into a text control (or a wrapper holding one), clear it, and type `value`. */
async function fillText(
  ctx: ToolContext,
  tabId: number,
  ref: string,
  objectId: string,
  backendNodeId: number,
  value: string,
): Promise<ToolResult> {
  // Click into it like a user (focus, caret, the component's own focus/click
  // handlers). If something covers it, focus it directly — typing does not need the pointer.
  try {
    const { x, y } = await locate(ctx, tabId, objectId, backendNodeId, { timeoutMs: 500 });
    await execCdpSeq(ctx, tabId, clickEvents(x, y));
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
  }
  let state = await focusState(ctx, tabId, objectId);
  if (!state.focused) {
    await execCdp(ctx, tabId, { method: 'DOM.focus', params: { objectId } });
    state = await focusState(ctx, tabId, objectId);
  }
  if (!state.editable) return errorResult(`${ref}: element does not accept typed text (click it and use browser_snapshot to find the real input)`);
  if (state.readOnly) return errorResult(`${ref}: input is read-only (pickers often are — click it and choose from the popup instead)`);

  if (state.value !== '') {
    await execCdpSeq(ctx, tabId, [...keyEvents('Control+A'), ...keyEvents('Backspace')]);
  }
  if (value.length > TYPE_LIMIT) await execCdp(ctx, tabId, insertTextCmd(value));
  else await execCdpSeq(ctx, tabId, typeEvents(value));

  // innerText of a contenteditable ends with the block's trailing newline.
  const after = (await focusState(ctx, tabId, objectId)).value.replace(/\n$/, '');
  const shown = after.length > 200 ? `${after.slice(0, 200)}…` : after;
  return after === value
    ? textResult(`filled ${ref}`)
    : textResult(`filled ${ref}; the field now shows "${shown}" (formatted, masked or length-limited by the page)`);
}

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
  description: 'DANGER: runs arbitrary JavaScript in the page via Runtime.evaluate and returns the value. Async is awaited — return a Promise or use an async IIFE and you get the resolved value directly (no need to stash results on window and poll). Permission-gated; only use with explicit user intent.',
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
  browser_hover_ref,
  browser_fill,
  browser_query,
  browser_get_text,
  browser_eval,
] as unknown as ToolDef[];
