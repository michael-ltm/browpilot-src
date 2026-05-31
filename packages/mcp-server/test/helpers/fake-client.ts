import type { RpcLike } from '../../src/context.js';

export interface RecordedRequest {
  method: string;
  params: unknown;
  timeoutMs?: number;
}

/** Records requests and replays queued/keyed responses. No network. */
export class FakeClient implements RpcLike {
  readonly calls: RecordedRequest[] = [];
  /** Per-CDP-method canned results for EXECUTE_CDP, keyed by inner cdp method. */
  private cdpResults = new Map<string, unknown>();
  /** Per-top-level-method canned results (e.g. GET_TABS). */
  private methodResults = new Map<string, unknown>();

  onCdp(cdpMethod: string, result: unknown): this {
    this.cdpResults.set(cdpMethod, result);
    return this;
  }
  onMethod(method: string, result: unknown): this {
    this.methodResults.set(method, result);
    return this;
  }

  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R> {
    this.calls.push({ method, params, timeoutMs });
    const p = params as { method?: string } | undefined;
    if (p && typeof p.method === 'string' && this.cdpResults.has(p.method)) {
      return Promise.resolve(this.cdpResults.get(p.method) as R);
    }
    if (this.methodResults.has(method)) {
      return Promise.resolve(this.methodResults.get(method) as R);
    }
    return Promise.resolve(undefined as R);
  }

  /** Convenience: last request issued. */
  last(): RecordedRequest {
    return this.calls[this.calls.length - 1];
  }
  /** All EXECUTE_CDP inner commands in order. */
  cdpCalls(): Array<{ method: string; params?: Record<string, unknown> }> {
    return this.calls
      .filter((c) => c.params && typeof (c.params as { method?: string }).method === 'string')
      .map((c) => c.params as { method: string; params?: Record<string, unknown> });
  }
}
