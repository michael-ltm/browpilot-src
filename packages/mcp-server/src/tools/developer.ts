import { z } from 'zod';
import { DeveloperBrowser } from '../developer/index.js';
import { defineTool, textResult, type ToolDef } from './types.js';

const developer = defineTool({
  name: 'browser_developer',
  description: 'Direct CDP session with full access to every extension — the way to operate extensions, since the regular tools (browser_eval, snapshots) are blocked by Chrome on other extensions\' pages and workers. ' +
    'launch starts a browser with DevTools and --enable-unsafe-extension-debugging (userDataDir = a profile directory; a generated profile when omitted). ' +
    'If that profile is already open, takeOver: true quits it gracefully and restarts it with DevTools on, restoring the last session and keeping its flags (ask the user first: it restarts their browser). ' +
    'connect attaches to an already-enabled loopback CDP port. ' +
    'extensions lists every extension\'s service worker / background page / open pages by extension id. ' +
    'extension_eval runs expression inside an extension (its worker, or its manifest.json page when the worker is asleep) with that extension\'s chrome.* APIs — read/write chrome.storage, call chrome.runtime.sendMessage to drive its background, chrome.tabs, etc. ' +
    'load_extension installs an unpacked extension from extensionPath (persists in the profile); extensionPath on launch does the same. ' +
    'To work with an extension page\'s UI, open it with command Target.createTarget {url: "chrome-extension://<id>/options.html"}, attach, then evaluate / command (Input.*, Page.captureScreenshot). ' +
    'targets lists all targets; attach returns sessionId; contexts lists execution contexts; evaluate requires sessionId and contextId; command sends any CDP method (Extensions.uninstall, Debugger, Network...). events polls bounded events using sequence as since. ' +
    'close disconnects; it terminates only a browser this session launched fresh, never a taken-over one.',
  inputSchema: {
    action: z.enum(['launch', 'connect', 'targets', 'attach', 'contexts', 'evaluate', 'command', 'events', 'close', 'extensions', 'extension_eval', 'load_extension']),
    executable: z.string().optional(), userDataDir: z.string().optional(), extensionPath: z.string().optional(),
    takeOver: z.boolean().optional(), args: z.array(z.string()).optional().describe('extra browser flags for launch'),
    extensionId: z.string().optional(), where: z.enum(['auto', 'worker', 'page']).optional().describe('extension_eval context; default auto'),
    port: z.number().int().min(1).max(65535).optional(), targetId: z.string().optional(), sessionId: z.string().optional(),
    contextId: z.number().int().optional(), expression: z.string().optional(), method: z.string().optional(),
    params: z.record(z.unknown()).optional(), since: z.number().int().nonnegative().optional(), clear: z.boolean().optional(),
  },
  async handler(args, ctx) {
    const required = <T>(value: T | undefined, name: string): T => { if (value === undefined || value === '') throw new Error(`${name} is required for ${args.action}`); return value; };
    // Validate before allocating any browser connection or process.
    if (args.action === 'launch') required(args.executable, 'executable');
    if (['contexts', 'evaluate'].includes(args.action)) required(args.sessionId, 'sessionId');
    if (args.action === 'extension_eval') { required(args.extensionId, 'extensionId'); required(args.expression, 'expression'); }
    if (args.action === 'load_extension') required(args.extensionPath, 'extensionPath');
    const browser = ctx.developer ??= new DeveloperBrowser();
    let result: unknown;
    switch (args.action) {
      case 'launch': result = await browser.launch({ executable: args.executable!, userDataDir: args.userDataDir, extensionPath: args.extensionPath, takeOver: args.takeOver, args: args.args }); break;
      case 'extensions': result = await browser.extensions(); break;
      case 'extension_eval': result = await browser.extensionEval(args.extensionId!, args.expression!, args.where); break;
      case 'load_extension': result = { extensionId: await browser.loadExtension(args.extensionPath!) }; break;
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
