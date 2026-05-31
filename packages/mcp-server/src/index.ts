import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './load-config.js';
import { BrokerClient } from './client.js';
import { createContext } from './context.js';
import { registerAll } from './tools/index.js';

// R4: re-export BrokerClient for M5 harness
export { BrokerClient };

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

/** R4: Thin wrapper — register all tools on an McpServer using a pre-built client. */
export function registerTools(server: McpServer, client: BrokerClient): void {
  registerAll(server, makeToolContext(client));
}

async function main(): Promise<void> {
  const config = loadConfig();

  const client = new BrokerClient({
    port: config.port,
    token: config.token,
    sessionId: randomUUID(),
  });

  const server = new McpServer({ name: 'claude-browser', version: '0.1.0' });
  const ctx = makeToolContext(client);
  registerAll(server, ctx);

  // Connect to the broker in the background: spawns it detached if down, then
  // auto-reconnects. Tool calls before it is ready reject with typed errors and
  // Claude can retry — we never block MCP startup on the browser link.
  void client.connectWithRetry();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only: stdout is the MCP stdio channel.
  process.stderr.write(`claude-browser-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
