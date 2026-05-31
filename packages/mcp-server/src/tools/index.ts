import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { ToolDef } from './types.js';
import { visionTools } from './vision.js';
import { domTools } from './dom.js';
import { navigationTools } from './navigation.js';
import { tabsTools } from './tabs.js';
import { consoleTools } from './console.js';

/** Every v1 browser_* tool, in a stable order. */
export const allTools: ToolDef[] = [
  ...visionTools,
  ...domTools,
  ...navigationTools,
  ...tabsTools,
  ...consoleTools,
];

/** Register all tools on an McpServer, threading the shared ToolContext. */
export function registerAll(server: McpServer, ctx: ToolContext): void {
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // SDK passes parsed args; we hand them and the context to our handler.
      (args: unknown) => tool.handler(args as never, ctx),
    );
  }
}
