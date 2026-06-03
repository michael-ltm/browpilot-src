import { z } from 'zod';
import { Method, type GetEventsResult, type CdpEvent } from '@claude-browser/shared';
import { defineTool, execCdp, textResult, type ToolDef, type ToolResult } from './types.js';
import type { ToolContext } from '../context.js';

const MAXLEN = 2000;
const trunc = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s;

interface ReqParams {
  requestId?: string;
  type?: string;
  request?: { method?: string; url?: string; postData?: string; headers?: Record<string, string> };
}
interface RespParams {
  requestId?: string;
  response?: { status?: number; mimeType?: string; headers?: Record<string, string> };
}
interface WsParams {
  requestId?: string;
  response?: { opcode?: number; payloadData?: string };
}

async function getEvents(ctx: ToolContext, methodPrefix: string, tabId: number): Promise<CdpEvent[]> {
  const browserId = ctx.selectedBrowserId ?? undefined;
  const res = await ctx.client.request<GetEventsResult>(Method.GET_EVENTS, {
    methodPrefix,
    tabId,
    ...(browserId ? { browserId } : {}),
  });
  return res.events;
}

const browser_network = defineTool({
  name: 'browser_network',
  description:
    'High-level HTTP + WebSocket capture (compact — strips the giant initiator stacks that raw browser_events returns). ' +
    'action "start": Network.enable + subscribe ["Network."]. ' +
    'action "requests": compact list {requestId, method, url, type, status, mime} (filter urlPattern substring, last `limit`). ' +
    'action "body": fetch a response body by requestId via Network.getResponseBody (truncated to maxLen). ' +
    'action "ws": compact WebSocket frames {t, dir, requestId, opcode, len, preview} (filter by requestId, last `limit`). ' +
    'action "stop": Network.disable.',
  inputSchema: {
    action: z.enum(['start', 'requests', 'body', 'ws', 'stop']),
    tabId: z.number().int(),
    urlPattern: z.string().optional(),
    requestId: z.string().optional(),
    limit: z.number().int().optional(),
    maxLen: z.number().int().optional(),
  },
  async handler(args, ctx): Promise<ToolResult> {
    const { action, tabId } = args;
    const maxLen = args.maxLen ?? MAXLEN;
    const limit = args.limit ?? 50;

    if (action === 'start') {
      await ctx.attach(tabId);
      // Subscribe before enabling so no early events are missed.
      const browserId = ctx.selectedBrowserId ?? undefined;
      await ctx.client.request(Method.SUBSCRIBE_EVENTS, {
        prefixes: ['Network.'],
        ...(browserId ? { browserId } : {}),
      });
      await execCdp(ctx, tabId, { method: 'Network.enable', params: {} });
      return textResult('network capture started (subscribed "Network." + Network.enable)');
    }

    if (action === 'stop') {
      await ctx.attach(tabId);
      await execCdp(ctx, tabId, { method: 'Network.disable', params: {} });
      return textResult('network capture stopped (Network.disable)');
    }

    if (action === 'body') {
      if (!args.requestId) return textResult('error: requestId required for action "body"');
      await ctx.attach(tabId);
      const out = await execCdp<{ body: string; base64Encoded: boolean }>(ctx, tabId, {
        method: 'Network.getResponseBody',
        params: { requestId: args.requestId },
      });
      const body = out?.body ?? '';
      return textResult(
        JSON.stringify({
          requestId: args.requestId,
          base64Encoded: out?.base64Encoded ?? false,
          length: body.length,
          body: trunc(body, maxLen),
        }),
      );
    }

    if (action === 'ws') {
      const sent = await getEvents(ctx, 'Network.webSocketFrameSent', tabId);
      const recv = await getEvents(ctx, 'Network.webSocketFrameReceived', tabId);
      let frames = [
        ...sent.map((e) => ({ e, dir: 'sent' as const })),
        ...recv.map((e) => ({ e, dir: 'recv' as const })),
      ]
        .map(({ e, dir }) => {
          const p = (e.params ?? {}) as WsParams;
          const payload = p.response?.payloadData ?? '';
          return {
            t: e.timestamp,
            dir,
            requestId: p.requestId,
            opcode: p.response?.opcode,
            len: payload.length,
            preview: trunc(payload, maxLen),
          };
        })
        .sort((a, b) => a.t - b.t);
      if (args.requestId) frames = frames.filter((f) => f.requestId === args.requestId);
      return textResult(JSON.stringify(frames.slice(-limit)));
    }

    // action === 'requests'
    const reqs = await getEvents(ctx, 'Network.requestWillBeSent', tabId);
    const resps = await getEvents(ctx, 'Network.responseReceived', tabId);
    const status = new Map<string, number | undefined>();
    const mime = new Map<string, string | undefined>();
    for (const e of resps) {
      const p = (e.params ?? {}) as RespParams;
      if (p.requestId) {
        status.set(p.requestId, p.response?.status);
        mime.set(p.requestId, p.response?.mimeType);
      }
    }
    let rows = reqs.map((e) => {
      const p = (e.params ?? {}) as ReqParams;
      const id = p.requestId ?? '';
      return {
        requestId: id,
        method: p.request?.method,
        url: p.request?.url ? trunc(p.request.url, maxLen) : undefined,
        type: p.type,
        status: status.get(id),
        mime: mime.get(id),
      };
    });
    if (args.urlPattern) rows = rows.filter((r) => r.url?.includes(args.urlPattern!));
    return textResult(JSON.stringify(rows.slice(-limit)));
  },
});

export const networkTools: ToolDef[] = [browser_network] as unknown as ToolDef[];
