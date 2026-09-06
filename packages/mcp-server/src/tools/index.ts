import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, type AmbiguousProfileData } from '@claude-browser/shared';
import type { ToolContext } from '../context.js';
import { textResult, type ToolDef } from './types.js';
import { RpcError } from '../client.js';
import { visionTools } from './vision.js';
import { domTools } from './dom.js';
import { navigationTools } from './navigation.js';
import { tabsTools } from './tabs.js';
import { consoleTools } from './console.js';
import { profileTools } from './profiles.js';
import { powerTools } from './power.js';
import { networkTools } from './network.js';
import { sourcesTools } from './sources.js';
import { debuggerTools } from './debugger.js';
import { detectTools } from './detect.js';

/** Every v1 browser_* tool, in a stable order. */
export const allTools: ToolDef[] = [
  ...visionTools,
  ...domTools,
  ...navigationTools,
  ...tabsTools,
  ...consoleTools,
  ...profileTools,
  ...powerTools,
  ...networkTools,
  ...sourcesTools,
  ...debuggerTools,
  ...detectTools,
];

/** Agent-facing guidance returned when multiple profiles are connected and none is selected. */
function ambiguousGuidance(data: AmbiguousProfileData): ReturnType<typeof textResult> {
  const list = data.profiles.map((p) => `- ${p.browserId} [${p.label}] ${p.status}`).join('\n');
  return textResult(
    `Multiple browser profiles are connected and none is selected:\n${list}\n` +
      `Ask the user which profile to use (present these as a native choice), then call ` +
      `browser_select_profile with the chosen browserId, then retry.`,
  );
}

/** Register all tools on an McpServer, threading the shared ToolContext. */
export function registerAll(server: McpServer, ctx: ToolContext): void {
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // SDK passes parsed args; we hand them and the context to our handler.
      // An AMBIGUOUS_PROFILE error becomes a non-fatal native-picker guidance result.
      async (args: unknown) => {
        try {
          return await tool.handler(args as never, ctx);
        } catch (e) {
          if (e instanceof RpcError && e.code === ErrorCode.AMBIGUOUS_PROFILE) {
            return ambiguousGuidance(e.data as AmbiguousProfileData);
          }
          throw e;
        }
      },
    );
  }
}
