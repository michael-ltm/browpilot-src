import { ErrorCode, Method, type ListProfilesResult, type ProfileInfo } from '@browpilot/shared';
import { RpcError } from './client.js';
import type { ToolContext } from './context.js';

const generations = new WeakMap<ToolContext, Map<string, { epoch: string; stale: boolean }>>();
const receipts = new WeakMap<Record<string, unknown>, { id: string; epoch: string }>();
const independent = new Set(['browser_list_profiles', 'browser_select_profile', 'browser_status', 'browser_logs', 'browser_list_instances', 'browser_register_instance', 'browser_open_instance', 'browser_install_extension', 'browser_developer']);

/** Check connection generations per MCP session, including reconnection caused by another session. */
export async function guardProfile(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (independent.has(name)) return input;
  let { profiles } = await ctx.client.request<ListProfilesResult>(Method.LIST_PROFILES, {});
  const explicit = typeof input.profile === 'string' ? input.profile : undefined;
  const wanted = explicit ?? ctx.selectedBrowserId;
  let matches = wanted ? profiles.filter(p => p.browserId === wanted || p.label === wanted) : profiles.filter(p => p.status === 'connected');
  if (matches.length > 1) return input; // The broker's ambiguity response remains authoritative.
  let profile: ProfileInfo | undefined = matches[0];
  let launched = false;
  if (wanted && (!profile || profile.status !== 'connected')) {
    const ensured = await ctx.client.request<{ browserId: string; launched: boolean }>(Method.ENSURE_LOCAL_INSTANCE, { id: profile?.browserId ?? wanted }, 20_000);
    launched = ensured.launched;
    if (!explicit) ctx.selectedBrowserId = ensured.browserId;
    else input = { ...input, profile: ensured.browserId };
    ({ profiles } = await ctx.client.request<ListProfilesResult>(Method.LIST_PROFILES, {}));
    profile = profiles.find(p => p.browserId === ensured.browserId);
    if (!profile) { if (launched) ctx.refs.clear(); return input; }
  }
  if (!profile) return input;
  let seen = generations.get(ctx);
  if (!seen) { seen = new Map(); generations.set(ctx, seen); }
  const epoch = `${profile.connectedAt}:${profile.reconnectCount}`;
  const previous = seen.get(profile.browserId);
  const stale = launched || !!previous && (previous.epoch !== epoch || previous.stale);
  if (stale) ctx.refs.clear();
  seen.set(profile.browserId, { epoch, stale });
  if (stale && (typeof input.tabId === 'number' || input.ref !== undefined)) {
    throw new RpcError(ErrorCode.STALE_REF, 'Browser connection changed. Fetch fresh browser_get_tabs and browser_snapshot results before using tab IDs or element references.');
  }
  const checked = { ...input };
  receipts.set(checked, { id: profile.browserId, epoch });
  return checked;
}

/** Only a successful tab listing clears stale state; failed/in-flight listings do not. */
export function acceptProfileResult(name: string, checked: Record<string, unknown>, ctx: ToolContext): void {
  if (name !== 'browser_get_tabs') return;
  const receipt = receipts.get(checked);
  if (!receipt) return;
  const state = generations.get(ctx)?.get(receipt.id);
  if (state?.epoch === receipt.epoch) state.stale = false;
}
