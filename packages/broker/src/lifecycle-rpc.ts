import { ErrorCode, Method, type JsonRpcMessage, type JsonRpcRequest } from '@claude-browser/shared';
import type { LocalBrowserManager } from './local/index.js';
import type { Router } from './router.js';

/** Preflight only: once forwarded, an operation is never automatically replayed. */
export async function routeWithLifecycle(router: Router, local: LocalBrowserManager, session: string, req: JsonRpcRequest): Promise<JsonRpcMessage> {
  const p = (req.params && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  const success = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: req.id, result });
  try {
    if (req.method === Method.LIST_LOCAL_INSTANCES) return success({ profiles: await local.list() });
    if (req.method === Method.REGISTER_LOCAL_INSTANCE) {
      if (!['chrome', 'edge', 'chromium'].includes(String(p.browser)) || typeof p.executable !== 'string' || typeof p.userDataDir !== 'string' ||
          (p.profileDirectory !== undefined && typeof p.profileDirectory !== 'string') || (p.label !== undefined && typeof p.label !== 'string')) throw new Error('Invalid browser registration');
      return success(await local.register(p as never));
    }
    if (req.method === Method.ENSURE_LOCAL_INSTANCE || req.method === Method.INSTALL_LOCAL_EXTENSION) {
      if (typeof p.id !== 'string') throw new Error('Local instance id is required');
      if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || !Number.isInteger(p.timeoutMs) || p.timeoutMs < 100 || p.timeoutMs > 60_000)) throw new Error('timeoutMs must be between 100 and 60000');
      return success(req.method === Method.ENSURE_LOCAL_INSTANCE ? await local.ensure(p.id, p.timeoutMs as number | undefined) : await local.openInstall(p.id));
    }
    // Status and logs must remain read-only and must never launch a browser.
    const introspection = [Method.LIST_PROFILES, Method.GET_PROFILE_STATUS, Method.GET_PROFILE_LOGS];
    if (!introspection.includes(req.method as never) && typeof p.browserId === 'string' && !router.connectedBrowserIds().includes(p.browserId)) {
      await local.list();
      if (local.canResolve(p.browserId)) {
        const ensured = await local.ensure(p.browserId);
        // A tab identifier from a prior browser process is unsafe after restart.
        const target = p.target as { tabId?: number } | undefined;
        if (ensured.launched && (typeof p.tabId === 'number' || typeof target?.tabId === 'number')) {
          return { jsonrpc: '2.0', id: req.id, error: { code: ErrorCode.STALE_REF, message: 'Browser was reopened. Call browser_get_tabs and browser_snapshot to obtain fresh tab IDs and references before retrying.' } };
        }
        req = { ...req, params: { ...p, browserId: ensured.browserId } };
      }
    }
    return await router.routeRequest(session, req);
  } catch (error) {
    return { jsonrpc: '2.0', id: req.id, error: { code: ErrorCode.INTERNAL, message: error instanceof Error ? error.message : String(error) } };
  }
}
