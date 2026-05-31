import { z } from 'zod';
import {
  clickEvents,
  keyEvents,
  wheelEvent,
  insertTextCmd,
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
    const cmd: CdpCommand = {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 },
    };
    await execCdp(ctx, tabId, cmd);
    return textResult(`moved to (${x}, ${y})`);
  },
});

const browser_type = defineTool({
  name: 'browser_type',
  description: 'Type literal text into the focused element via Input.insertText.',
  inputSchema: { text: z.string(), tabId: z.number().int() },
  async handler({ text, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, insertTextCmd(text));
    return textResult(`typed ${text.length} chars`);
  },
});

const browser_press_key = defineTool({
  name: 'browser_press_key',
  description: 'Press a key or chord, e.g. "Enter", "Cmd+A", "Control+L", "ArrowDown".',
  inputSchema: { keys: z.string(), tabId: z.number().int() },
  async handler({ keys, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdpSeq(ctx, tabId, keyEvents(keys));
    return textResult(`pressed ${keys}`);
  },
});

const browser_scroll = defineTool({
  name: 'browser_scroll',
  description: 'Scroll by (deltaX, deltaY) at optional (x,y); positive deltaY scrolls down.',
  inputSchema: {
    deltaX: z.number(),
    deltaY: z.number(),
    x: z.number().optional(),
    y: z.number().optional(),
    tabId: z.number().int(),
  },
  async handler({ deltaX, deltaY, x, y, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, wheelEvent(deltaX, deltaY, x ?? 0, y ?? 0));
    return textResult(`scrolled (${deltaX}, ${deltaY})`);
  },
});

const browser_drag = defineTool({
  name: 'browser_drag',
  description: 'Drag from (fromX,fromY) to (toX,toY): press at start, move to end, release.',
  inputSchema: {
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    tabId: z.number().int(),
  },
  async handler({ fromX, fromY, toX, toY, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const cmds: CdpCommand[] = [
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: toX, y: toY, button: 'left', buttons: 1, clickCount: 0 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 },
      },
    ];
    await execCdpSeq(ctx, tabId, cmds);
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
