import { Method, type AttachParams } from '@claude-browser/shared';

/** The subset of BrokerClient that tools depend on (so tests can fake it). */
export interface RpcLike {
  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R>;
}

/** Per-session tool context: the RPC client + snapshot ref map + selected profile. */
export interface ToolContext {
  client: RpcLike;
  /** ref string -> backendDOMNodeId, populated by browser_snapshot. */
  refs: Map<string, number>;
  /** Ensure the debugger is attached to a tab before issuing CDP. */
  attach(tabId: number, browserId?: string): Promise<void>;
  /** Remembered profile for this session; set by browser_select_profile. */
  selectedBrowserId: string | null;
  /** Pinned connector extension id, for browser_detect. Null if unknown. */
  extensionId: string | null;
  /** Unpacked extension dir to load/point the user at. Null if not bundled. */
  extensionDir: string | null;
}

/** Optional bits of context the MCP entry point knows but tool tests do not. */
export interface ContextOptions {
  extensionId?: string | null;
  extensionDir?: string | null;
}

export function createContext(client: RpcLike, opts: ContextOptions = {}): ToolContext {
  const refs = new Map<string, number>();
  const ctx: ToolContext = {
    client,
    refs,
    selectedBrowserId: null,
    extensionId: opts.extensionId ?? null,
    extensionDir: opts.extensionDir ?? null,
    async attach(tabId: number, browserId?: string): Promise<void> {
      const bid = browserId ?? ctx.selectedBrowserId ?? undefined;
      const params: AttachParams = bid ? { tabId, browserId: bid } : { tabId };
      await client.request(Method.ATTACH, params);
    },
  };
  return ctx;
}

/** Resolve the browserId param for a request: explicit -> selected -> none. */
export function profileParam(ctx: ToolContext, explicit?: string): { browserId?: string } {
  const bid = explicit ?? ctx.selectedBrowserId ?? undefined;
  return bid ? { browserId: bid } : {};
}
