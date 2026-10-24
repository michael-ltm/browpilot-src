import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectStdioSession } from './stdio.js';
import { loadConfig } from './load-config.js';
import { ensureConfig } from './bootstrap.js';
import { BrokerClient } from './client.js';
import { createContext } from './context.js';
import { registerAll } from './tools/index.js';
import { parseCommand, clientRegistration, clientConfig, type Command } from './cli.js';
import { startHttpMcp } from './http.js';

// R4: re-export BrokerClient for M5 harness
export { BrokerClient };

/**
 * Narrow interface covering the only McpServer surface that registerAll uses.
 * Accepting this instead of the full McpServer class lets test harnesses pass a
 * minimal capture-sink without a double-escape cast (as unknown as McpServer).
 */
export interface McpToolRegistrar {
  registerTool(name: string, config: unknown, handler: (...args: never[]) => unknown): void;
}

/** R4: Factor the context-builder out of main() so M5 harness can reuse it. */
export function makeToolContext(client: BrokerClient): ReturnType<typeof createContext> {
  return createContext(client);
}

/** R4: Thin wrapper — create + connect a BrokerClient. */
export async function createClient(opts: {
  port: number;
  token: string;
  sessionId?: string;
}): Promise<BrokerClient> {
  const client = new BrokerClient({
    port: opts.port,
    token: opts.token,
    sessionId: opts.sessionId ?? randomUUID(),
  });
  await client.connectWithRetry();
  return client;
}

/** R4: Thin wrapper — register all tools on an McpServer using a pre-built client.
 *  Accepts McpToolRegistrar so test harnesses can pass a capture-sink directly,
 *  without a double-escape cast. McpServer satisfies this interface. */
export function registerTools(server: McpToolRegistrar, client: BrokerClient): void {
  registerAll(server as McpServer, makeToolContext(client));
}

export type CliCommand = Command;
export const parseCli = parseCommand;

/** Locate the bundled extension dir in packaged (../extension) and dev (../../extension/dist) layouts. */
export function resolveExtensionDir(here: string, exists: (p: string) => boolean = existsSync): string | null {
  const packaged = resolvePath(here, '../extension');         // published: dist/mcp.js -> ../extension
  if (exists(resolvePath(packaged, 'manifest.json'))) return packaged;
  const dev = resolvePath(here, '../../extension/dist');      // monorepo dev
  if (exists(resolvePath(dev, 'manifest.json'))) return dev;
  return null;
}

/** Read the version from the co-located package.json (published: dist/mcp.js -> ../package.json). */
function readPackageVersion(here: string): string {
  try {
    return (
      (JSON.parse(readFileSync(resolvePath(here, '../package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

async function main(httpPort?: number): Promise<void> {
  // First-run bootstrap (npx flow): write ~/.claude-browser/config.json if absent,
  // deriving extensionId from the bundled extension manifest. No-op if it exists.
  const here = dirname(fileURLToPath(import.meta.url));
  ensureConfig(resolveExtensionDir(here));
  const config = loadConfig();

  const session = () => {
    const client = new BrokerClient({
    port: config.port,
    token: config.token,
    sessionId: randomUUID(),
  });

  const server = new McpServer({ name: 'browpilot', version: readPackageVersion(here) }, {
    instructions: 'Browpilot controls user-selected browser profiles. Use browser_list_instances to discover installed browsers and browser_open_instance to launch/pair one. Use browser_get_tabs and a fresh browser_snapshot after reconnect or restart. Do not replay a mutation whose outcome is unknown. Developer tools use a separate debugging session. Installation requires confirmation in the browser.',
  });
  const ctx = makeToolContext(client);
  registerAll(server, ctx);

  // Connect to the broker in the background: spawns it detached if down, then
  // auto-reconnects. Tool calls before it is ready reject with typed errors and
  // Claude can retry — we never block MCP startup on the browser link.
  void client.connectWithRetry().catch(error => process.stderr.write(`Browpilot broker: ${error.message}\n`));
  return { server, dispose: async () => { client.close(); await ctx.developer?.close(); } };
  };

  if (httpPort !== undefined) {
    const http = await startHttpMcp({ port: httpPort, token: process.env.BROWPILOT_HTTP_TOKEN ?? '',
      allowedOrigins: process.env.BROWPILOT_HTTP_ORIGINS?.split(',').map(v => v.trim()).filter(Boolean), createSession: session });
    process.stderr.write(`Browpilot HTTP MCP: http://127.0.0.1:${http.port}/mcp (bearer authentication required)\n`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void http.close().then(() => process.exit(0)); });
    return;
  }

  await connectStdioSession(session());
}

/**
 * True when this module is the process entry point. argv[1] is realpath-resolved
 * because npm/npx invoke bins through a `.bin` symlink, whereas import.meta.url
 * is already symlink-resolved by Node — without this, the entry check fails
 * under npx and the MCP server never starts (Claude sees ConnectionClosed
 * -32000). Exported + realpath-injectable so it can be unit-tested.
 */
export function isMainModule(
  moduleUrl: string,
  argvPath: string | undefined,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (argvPath === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpath(argvPath)).href;
  } catch {
    return false;
  }
}

// Only run the MCP server when this module is the process entry point. Importing
// the library barrel (the integration harness imports createClient/registerTools)
// must NOT start a stdio server or call process.exit.
const isEntry = isMainModule(import.meta.url, process.argv[1]);
if (isEntry) {
  const cmd = parseCli(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  if (cmd.kind === 'mcp' || cmd.kind === 'http') {
    main(cmd.kind === 'http' ? cmd.port : undefined).catch((err) => {
      process.stderr.write(`claude-browser-mcp fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
  } else if (cmd.kind === 'extension-path') {
    const dir = resolveExtensionDir(here);
    if (dir) process.stdout.write(dir + '\n');
    else { process.stderr.write('extension dir not found\n'); process.exit(1); }
  } else if (cmd.kind === 'install') {
    const registration = clientRegistration(cmd.client ?? 'claude', fileURLToPath(import.meta.url));
    const r = spawnSync(registration.command, registration.args, { stdio: 'inherit' });
    if (r.error) process.stderr.write(`Could not register Browpilot: ${r.error.message}\n`);
    process.exit(r.status ?? 1);
  } else if (cmd.kind === 'config') {
    process.stdout.write(clientConfig(cmd.client, fileURLToPath(import.meta.url)));
  } else if (cmd.kind === 'version') {
    process.stdout.write('Browpilot ' + readPackageVersion(here) + '\n');
  } else {
    process.stdout.write(
      'Usage:\n  browpilot                      run stdio MCP\n' +
      '  browpilot install codex|claude  register this installation with a client\n' +
      '  browpilot config codex|claude   print client configuration\n' +
      '  browpilot serve --port 8788     HTTP MCP; requires BROWPILOT_HTTP_TOKEN\n' +
      '  browpilot extension-path       print the bundled extension directory\n',
    );
  }
}
