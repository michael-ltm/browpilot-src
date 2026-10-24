import { z } from 'zod';
import { DeveloperBrowser } from '../developer/index.js';
import { defineTool, textResult, type ToolDef } from './types.js';

const developer = defineTool({
  name: 'browser_developer',
  description: 'Developer-only direct CDP session for debugging browser extensions. launch starts a dedicated browser profile; connect attaches to an already-enabled loopback CDP port. targets lists extension pages/workers; attach returns sessionId; contexts lists execution contexts; evaluate requires sessionId and contextId; command sends CDP (breakpoints, source, Network etc.). events polls bounded events using sequence as since. close disconnects and terminates only the browser this session launched. Stock Chrome may require manually loading extensions; Chrome for Testing/Chromium supports extensionPath.',
  inputSchema: {
    action: z.enum(['launch', 'connect', 'targets', 'attach', 'contexts', 'evaluate', 'command', 'events', 'close']),
    executable: z.string().optional(), userDataDir: z.string().optional(), extensionPath: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(), targetId: z.string().optional(), sessionId: z.string().optional(),
    contextId: z.number().int().optional(), expression: z.string().optional(), method: z.string().optional(),
    params: z.record(z.unknown()).optional(), since: z.number().int().nonnegative().optional(), clear: z.boolean().optional(),
  },
  async handler(args, ctx) {
    const required = <T>(value: T | undefined, name: string): T => { if (value === undefined || value === '') throw new Error(`${name} is required for ${args.action}`); return value; };
    // Validate before allocating any browser connection or process.
    if (args.action === 'launch') required(args.executable, 'executable');
    if (['contexts', 'evaluate'].includes(args.action)) required(args.sessionId, 'sessionId');
    const browser = ctx.developer ??= new DeveloperBrowser();
    let result: unknown;
    switch (args.action) {
      case 'launch': result = await browser.launch({ executable: args.executable!, userDataDir: args.userDataDir, extensionPath: args.extensionPath }); break;
      case 'connect': await browser.connect(required(args.port, 'port')); result = { connected: true }; break;
      case 'targets': result = await browser.targets(); break;
      case 'attach': result = await browser.attach(required(args.targetId, 'targetId')); break;
      case 'contexts':
        result = await browser.contexts(args.sessionId!);
        break;
      case 'evaluate': result = await browser.command({ method: 'Runtime.evaluate', sessionId: args.sessionId, params: { expression: required(args.expression, 'expression'), contextId: required(args.contextId, 'contextId'), awaitPromise: true, returnByValue: true } }); break;
      case 'command': result = await browser.command({ method: required(args.method, 'method'), params: args.params, sessionId: args.sessionId }); break;
      case 'events': result = browser.events({ sessionId: args.sessionId, since: args.since, clear: args.clear }); break;
      case 'close': await browser.close(); ctx.developer = undefined; result = { closed: true }; break;
    }
    return textResult(JSON.stringify(result ?? null));
  },
});

export const developerTools: ToolDef[] = [developer] as unknown as ToolDef[];
