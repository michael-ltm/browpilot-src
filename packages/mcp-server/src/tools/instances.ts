import { z } from 'zod';
import { Method } from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef } from './types.js';

export const instanceTools: ToolDef[] = [
  defineTool({ name: 'browser_list_instances', description: 'Discover local Chrome, Edge and Chromium profiles, including closed browsers. Shows extension installation separately from connection. Use browser_open_instance with the exact local id to pair and select one.', inputSchema: {},
    async handler(_, ctx) { return textResult(JSON.stringify(await ctx.client.request(Method.LIST_LOCAL_INSTANCES, {}))); },
  }),
  defineTool({ name: 'browser_register_instance', description: 'Register a custom browser executable and user-data directory for discovery and on-demand startup. Does not change browser Preferences.',
    inputSchema: { browser: z.enum(['chrome', 'edge', 'chromium']), executable: z.string(), userDataDir: z.string(), profileDirectory: z.string().optional(), label: z.string().optional() },
    async handler(args, ctx) { return textResult(JSON.stringify(await ctx.client.request(Method.REGISTER_LOCAL_INSTANCE, args))); },
  }),
  defineTool({ name: 'browser_open_instance', description: 'Open the specified local browser profile, wait for verified extension pairing and select it for this MCP session. Already connected instances are reused. Refresh tabs and snapshots after opening.',
    inputSchema: { id: z.string(), timeoutMs: z.number().int().min(100).max(60000).optional() },
    async handler(args, ctx) {
      const result = await ctx.client.request<{ browserId: string; launched: boolean }>(Method.ENSURE_LOCAL_INSTANCE, args, (args.timeoutMs ?? 15000) + 5000);
      ctx.selectedBrowserId = result.browserId;
      ctx.refs.clear();
      return textResult(JSON.stringify(result));
    },
  }),
  defineTool({ name: 'browser_install_extension', description: 'Open the selected profile at its configured extension store page or unpacked-install settings. The user must confirm installation in the browser. Then call browser_open_instance to verify pairing.',
    inputSchema: { id: z.string() },
    async handler(args, ctx) { return textResult(JSON.stringify(await ctx.client.request(Method.INSTALL_LOCAL_EXTENSION, args))); },
  }),
] as ToolDef[];
