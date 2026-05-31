import { z } from 'zod';
import { Method, type ExecuteCdpParams, type CdpTarget } from '@claude-browser/shared';
import type { ToolContext } from '../context.js';
import type { CdpCommand } from '../cdp.js';

/** MCP-ish content block returned by a tool handler.
 * The index signature satisfies McpServer.registerTool()'s CallToolResult constraint
 * (CallToolResultSchema uses z.core.$loose which requires { [x: string]: unknown }).
 */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** A registrable tool: name + description + zod schema + handler. */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Helper to declare a tool with inferred arg typing. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Run one CDP command via EXECUTE_CDP against a tab. */
export function execCdp<R = unknown>(
  ctx: ToolContext,
  tabId: number,
  cmd: CdpCommand,
  timeoutMs?: number,
): Promise<R> {
  const target: CdpTarget = { tabId };
  const params: ExecuteCdpParams = {
    target,
    method: cmd.method,
    params: cmd.params,
    timeoutMs,
  };
  return ctx.client.request<R>(Method.EXECUTE_CDP, params, timeoutMs);
}

/** Run an ordered list of CDP commands sequentially. */
export async function execCdpSeq(
  ctx: ToolContext,
  tabId: number,
  cmds: CdpCommand[],
): Promise<void> {
  for (const cmd of cmds) await execCdp(ctx, tabId, cmd);
}

/** Plain text result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
