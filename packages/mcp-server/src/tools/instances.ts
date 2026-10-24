import { z } from 'zod';
import { Method, type LocalBrowserProfile } from '@browpilot/shared';
import { defineTool, textResult, type ToolDef } from './types.js';
import { launcherInstall } from './detect.js';

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
  defineTool({ name: 'browser_install_extension', description: 'Install the Browpilot extension into a profile. With a local id from browser_list_instances, opens its configured store page or unpacked-install settings; the user must confirm installation in the browser, then call browser_open_instance to verify pairing. Add allowRestart:true (ask the user first) to instead close and reopen that real profile and load the extension over the DevTools protocol where the browser allows it; this load lasts one browser session. Without an id, index/family pick an entry from browser_detect for the same controlled relaunch.',
    inputSchema: {
      id: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      family: z.enum(['chrome', 'edge', 'brave', 'chromium']).optional(),
      profileDirectory: z.string().optional(),
      allowRestart: z.boolean().optional(),
    },
    async handler({ id, index, family, profileDirectory, allowRestart }, ctx) {
      if (id === undefined) return launcherInstall(ctx, { ...(index !== undefined ? { index } : {}), ...(family ? { family } : {}) }, { ...(profileDirectory ? { profileDirectory } : {}), ...(allowRestart !== undefined ? { allowRestart } : {}) });
      if (allowRestart !== true) return textResult(JSON.stringify(await ctx.client.request(Method.INSTALL_LOCAL_EXTENSION, { id })));
      const { profiles } = await ctx.client.request<{ profiles: LocalBrowserProfile[] }>(Method.LIST_LOCAL_INSTANCES, {});
      const profile = profiles.find(p => p.id === id);
      if (!profile) return { ...textResult(`no local instance with id ${id}; run browser_list_instances first`), isError: true };
      return launcherInstall(ctx, { userDataDir: profile.userDataDir }, { profileDirectory: profileDirectory ?? profile.profileDirectory, allowRestart: true });
    },
  }),
] as ToolDef[];
