import { Method, type AttachParams } from '@claude-browser/shared';

/** The subset of BrokerClient that tools depend on (so tests can fake it). */
export interface RpcLike {
  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R>;
}

/** Per-session tool context: the RPC client + snapshot ref map. */
export interface ToolContext {
  client: RpcLike;
  /** ref string -> backendDOMNodeId, populated by browser_snapshot. */
  refs: Map<string, number>;
  /** Ensure the debugger is attached to a tab before issuing CDP. */
  attach(tabId: number): Promise<void>;
}

export function createContext(client: RpcLike): ToolContext {
  const refs = new Map<string, number>();
  return {
    client,
    refs,
    async attach(tabId: number): Promise<void> {
      const params: AttachParams = { tabId };
      await client.request(Method.ATTACH, params);
    },
  };
}
