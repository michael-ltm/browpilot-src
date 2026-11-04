import { z } from 'zod';
import {
  Method,
  type ExtensionInfo,
  type ListExtensionsResult,
  type ManageExtensionResult,
  type MessageExtensionResult,
} from '@browpilot/shared';
import { defineTool, textResult, type ToolResult } from './types.js';
import { profileParam, type ToolContext } from '../context.js';

function describe(e: ExtensionInfo): string {
  const flags = [e.enabled ? 'enabled' : `disabled${e.disabledReason ? ` (${e.disabledReason})` : ''}`, e.installType];
  if (e.isSelf) flags.push('this is Browpilot');
  if (e.optionsUrl) flags.push(`options: ${e.optionsUrl}`);
  return `${e.id}  ${e.name} ${e.version}  [${flags.join(', ')}]`;
}

/** Accept an extension id, or a name (case-insensitive, unique substring). */
async function resolveId(ctx: ToolContext, ref: string, profile?: string): Promise<string> {
  if (/^[a-p]{32}$/.test(ref)) return ref;
  const { extensions } = await ctx.client.request<ListExtensionsResult>(Method.LIST_EXTENSIONS, { ...profileParam(ctx, profile) });
  const q = ref.toLowerCase();
  const exact = extensions.filter((e) => e.name.toLowerCase() === q);
  const hits = exact.length ? exact : extensions.filter((e) => e.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0]!.id;
  if (!hits.length) throw new Error(`no installed extension matches "${ref}"; run action "list"`);
  throw new Error(`"${ref}" matches several extensions:\n${hits.map(describe).join('\n')}\nPass the id instead.`);
}

const browser_extensions = defineTool({
  name: 'browser_extensions',
  description:
    'Manage and drive other extensions in the selected profile. list: installed extensions (id, version, unpacked or store, options page). ' +
    'reload: re-read an unpacked extension from disk after editing its files (same as the reload button; id = Browpilot reloads itself). ' +
    'enable / disable. open_options: open its options page in a new tab. ' +
    'message: chrome.runtime.sendMessage(id, message) and return the reply — the target must listen on chrome.runtime.onMessageExternal; ' +
    'this is how to read or change an extension\'s settings, because Chrome blocks DevTools (browser_eval, snapshots) on other extensions\' pages. ' +
    'Loading a new unpacked extension is not possible from inside the browser: the user loads it once on chrome://extensions, then reload works.',
  inputSchema: {
    action: z.enum(['list', 'reload', 'enable', 'disable', 'open_options', 'message']),
    id: z.string().optional().describe('extension id or name (unique substring); required except for list'),
    message: z.unknown().optional().describe('JSON message for action "message"'),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    profile: z.string().optional(),
  },
  async handler({ action, id, message, timeoutMs, profile }, ctx): Promise<ToolResult> {
    const bp = profileParam(ctx, profile);
    if (action === 'list') {
      const { extensions } = await ctx.client.request<ListExtensionsResult>(Method.LIST_EXTENSIONS, bp);
      return textResult(extensions.map(describe).join('\n') || '(no extensions)');
    }
    if (!id) return { ...textResult(`action "${action}" needs id`), isError: true };
    const extId = await resolveId(ctx, id, profile);
    if (action === 'message') {
      const res = await ctx.client.request<MessageExtensionResult>(Method.MESSAGE_EXTENSION, { id: extId, message: message ?? null, timeoutMs, ...bp });
      return textResult(JSON.stringify(res.response, null, 2));
    }
    const res = await ctx.client.request<ManageExtensionResult>(Method.MANAGE_EXTENSION, { id: extId, action, ...bp });
    const parts = [res.extension ? describe(res.extension) : extId];
    if (res.tabId !== undefined) parts.push(`opened options in tab ${res.tabId}`);
    if (res.detail) parts.push(res.detail);
    return textResult(`${action}: ${parts.join(' — ')}`);
  },
});

export const extensionTools = [browser_extensions] as unknown as import('./types.js').ToolDef[];
