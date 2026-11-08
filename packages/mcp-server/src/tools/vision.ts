import { z } from 'zod';
import {
  clickEvents,
  dragEvents,
  hoverEvent,
  keyEvents,
  typeEvents,
  wheelEvent,
  screenshotParams,
  type CdpCommand,
} from '../cdp.js';
import {
  defineTool,
  execCdp,
  execCdpSeq,
  textResult,
  type ToolDef,
  type ToolResult,
} from './types.js';

const buttonEnum = z.enum(['left', 'right', 'middle']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for the command that completes one typed character (its key-up, or an IME commit). */
function endsKeystroke(cmd: CdpCommand): boolean {
  if (cmd.method === 'Input.insertText') return true;
  const key = cmd.params.key;
  return cmd.params.type === 'keyUp' && key !== 'Shift' && key !== 'Control' && key !== 'Alt' && key !== 'Meta';
}

const browser_screenshot = defineTool({
  name: 'browser_screenshot',
  description: 'Capture a screenshot of the page (PNG). Pixels equal CSS pixels (deviceScaleFactor=1).',
  inputSchema: {
    fullPage: z.boolean().optional().describe('Capture the full scrollable page, not just the viewport.'),
    tabId: z.number().int().describe('The tab to screenshot.'),
  },
  async handler({ fullPage, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const result = await execCdp<{ data: string }>(ctx, tabId, {
      method: 'Page.captureScreenshot',
      params: screenshotParams(fullPage ?? false),
    });
    return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
  },
});

const browser_click = defineTool({
  name: 'browser_click',
  description: 'Click at viewport coordinates (x,y). button defaults to left, count to 1 (use 2 for double-click).',
  inputSchema: {
    x: z.number(),
    y: z.number(),
    button: buttonEnum.optional(),
    count: z.number().int().min(1).optional(),
    tabId: z.number().int(),
  },
  async handler({ x, y, button, count, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdpSeq(ctx, tabId, clickEvents(x, y, button ?? 'left', count ?? 1));
    return textResult(`clicked (${x}, ${y})`);
  },
});

const browser_move = defineTool({
  name: 'browser_move',
  description: 'Move the mouse to viewport coordinates (x,y) without pressing.',
  inputSchema: { x: z.number(), y: z.number(), tabId: z.number().int() },
  async handler({ x, y, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, hoverEvent(x, y));
    return textResult(`moved to (${x}, ${y})`);
  },
});

const browser_type = defineTool({
  name: 'browser_type',
  description:
    'Type text into the focused element key by key, like a user: each character fires keydown/keypress/beforeinput/input/keyup ' +
    '(Shift held for capitals and symbols, "\\n" presses Enter); Chinese, emoji and other text not on a US keyboard is committed ' +
    'through IME composition events. Appends at the caret. delayMs waits between keystrokes (for debounced search boxes).',
  inputSchema: {
    text: z.string(),
    delayMs: z.number().int().min(0).max(2000).optional(),
    tabId: z.number().int(),
  },
  async handler({ text, delayMs, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const cmds = typeEvents(text);
    if (!delayMs) {
      await execCdpSeq(ctx, tabId, cmds);
    } else {
      for (const cmd of cmds) {
        await execCdp(ctx, tabId, cmd);
        if (endsKeystroke(cmd)) await sleep(delayMs);
      }
    }
    return textResult(`typed ${[...text].length} chars`);
  },
});

const browser_press_key = defineTool({
  name: 'browser_press_key',
  description:
    'Press a key or chord with real key events, e.g. "Enter", "Escape", "Tab", "Shift+Tab", "ArrowDown", "Control+A", "F5". ' +
    'Keys that type a character fire keypress/input too, so Enter submits forms and Space toggles buttons. ' +
    'Ctrl/Cmd + A, C, X, V, Z, Y run select-all/copy/cut/paste/undo/redo on every platform.',
  inputSchema: { keys: z.string(), tabId: z.number().int() },
  async handler({ keys, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdpSeq(ctx, tabId, keyEvents(keys));
    return textResult(`pressed ${keys}`);
  },
});

const browser_scroll = defineTool({
  name: 'browser_scroll',
  description: 'Scroll with the mouse wheel by (deltaX, deltaY) with the pointer at (x,y) — defaults to the viewport center; positive deltaY scrolls down. Point at a scrollable panel to scroll it.',
  inputSchema: {
    deltaX: z.number(),
    deltaY: z.number(),
    x: z.number().optional(),
    y: z.number().optional(),
    tabId: z.number().int(),
  },
  async handler({ deltaX, deltaY, x, y, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    let px = x;
    let py = y;
    if (px === undefined || py === undefined) {
      const vp = await execCdp<{ result?: { value?: [number, number] } }>(ctx, tabId, {
        method: 'Runtime.evaluate',
        params: { expression: '[innerWidth / 2, innerHeight / 2]', returnByValue: true },
      });
      const [cx, cy] = vp?.result?.value ?? [0, 0];
      px ??= cx;
      py ??= cy;
    }
    await execCdp(ctx, tabId, wheelEvent(deltaX, deltaY, px, py));
    return textResult(`scrolled (${deltaX}, ${deltaY})`);
  },
});

const browser_drag = defineTool({
  name: 'browser_drag',
  description:
    'Drag with the real mouse from (fromX,fromY) to (toX,toY): hover, press, move in `steps` small moves (default 10) with the button held, release. ' +
    'Works for pointer-based drag libraries (SortableJS, dnd-kit, vuedraggable) and native HTML5 drag-and-drop.',
  inputSchema: {
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    steps: z.number().int().min(1).max(100).optional(),
    tabId: z.number().int(),
  },
  async handler({ fromX, fromY, toX, toY, steps, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdpSeq(ctx, tabId, dragEvents(fromX, fromY, toX, toY, steps ?? 10));
    return textResult(`dragged (${fromX},${fromY}) -> (${toX},${toY})`);
  },
});

export const visionTools: ToolDef[] = [
  browser_screenshot,
  browser_click,
  browser_move,
  browser_type,
  browser_press_key,
  browser_scroll,
  browser_drag,
] as unknown as ToolDef[];
