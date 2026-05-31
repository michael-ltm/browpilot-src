import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, type LaunchedChrome } from 'chrome-launcher';
import { resolvePaths } from '../../scripts/lib/paths.js';
import { readPinnedExtensionId } from '../../scripts/lib/manifest.js';
import { type Config } from '@claude-browser/shared';
// R1: Broker exposes an in-process server factory via `startServer` (not `createServer`).
// R4: client + tool registration come from the mcp-server package.
import { startServer, type BrokerServer } from '@claude-browser/broker';
import { createClient, registerTools, type BrokerClient } from '@claude-browser/mcp-server';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

/** Tests call this first; when false the whole spec turns into a skip. */
export function shouldRunBrowserTests(): boolean {
  return process.env.RUN_BROWSER_TESTS === '1';
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface Harness {
  config: Config;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Drop the broker's browser-side socket to simulate service-worker death. */
  forceExtensionOffline(): void;
  /** Recreate only the agent (MCP) client; broker + Chrome stay alive. */
  restartMcpClient(): Promise<void>;
  teardown(): Promise<void>;
}

interface Internal {
  tmpRoot: string;
  userDataDir: string;
  chrome: LaunchedChrome;
  broker: BrokerServer;
  client: BrokerClient;
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
}

async function ephemeralPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as import('node:net').AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

export async function startHarness(): Promise<Harness> {
  const paths = resolvePaths(REPO_ROOT, tmpdir());
  const tmpRoot = await mkdtemp(join(tmpdir(), 'cb-harness-'));
  const userDataDir = join(tmpRoot, 'chrome-profile');
  await mkdir(userDataDir, { recursive: true });

  const port = await ephemeralPort();
  const extensionId = await readPinnedExtensionId(paths.extensionDist);
  const token = 'integration-test-token-0000000000000000000000000000000000000000';
  const config: Config = { port, token, extensionId };

  // Write a temp config the broker reads; broker binds 127.0.0.1:<port>.
  const tmpConfigDir = join(tmpRoot, '.claude-browser');
  await mkdir(tmpConfigDir, { recursive: true });
  await writeFile(join(tmpConfigDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  // R1: use startServer (canonical export from @claude-browser/broker).
  const broker = await startServer(config);

  // Headful Chrome: chrome.debugger + MV3 service workers are unreliable in
  // headless mode, so we launch a real window (CI must allow a display, e.g.
  // via Xvfb on Linux; on macOS dev machines this just opens a window).
  const chrome = await launch({
    chromeFlags: [
      `--load-extension=${paths.extensionDist}`,
      `--disable-extensions-except=${paths.extensionDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-timer-throttling',
    ],
    userDataDir,
    ignoreDefaultFlags: false,
  });

  // Build the agent client + register the real browser_* tools against it so
  // tests drive the actual tool handlers.
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  let client = await createClient({ port, token });
  registerInto(tools, client);

  // Wait until the extension has connected to the broker (status -> connected),
  // up to 15s, otherwise tool calls will all error with EXTENSION_DISCONNECTED.
  await waitForExtension(broker, 15_000);

  const internal: Internal = { tmpRoot, userDataDir, chrome, broker, client, tools };

  return {
    config,
    async callTool(name, args) {
      const fn = internal.tools.get(name);
      if (!fn) throw new Error(`tool not registered: ${name}`);
      return fn(args);
    },
    forceExtensionOffline() {
      // Public broker test hook: forcibly close the single browser-side socket.
      internal.broker.dropBrowserConnection();
    },
    async restartMcpClient() {
      await internal.client.close();
      internal.tools.clear();
      internal.client = await createClient({ port, token });
      registerInto(internal.tools, internal.client);
    },
    async teardown() {
      try {
        await internal.client.close();
      } catch {
        /* ignore */
      }
      await internal.broker.close();
      await internal.chrome.kill();
      await rm(internal.tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Register the real browser_* tool handlers, capturing each into a map we can call. */
function registerInto(
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>,
  client: BrokerClient,
): void {
  // registerTools calls registerAll which calls server.registerTool(name, config, handler).
  // We pass a minimal McpServer-like sink that intercepts registerTool calls to capture
  // the handlers without a full StdioServerTransport. Each captured handler returns
  // the same {content,isError} shape the MCP SDK uses.
  // Cast through unknown because we only need the registerTool surface, not the full McpServer.
  type McpServerSink = { registerTool(name: string, config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void };
  const sink: McpServerSink = {
    registerTool(name, _config, handler) {
      tools.set(name, handler);
    },
  };
  registerTools(sink as unknown as Parameters<typeof registerTools>[0], client);
}

/** Resolve once the broker reports a connected browser side, else reject on timeout. */
function waitForExtension(broker: BrokerServer, timeoutMs: number): Promise<void> {
  return new Promise((res, rej) => {
    if (broker.hasBrowserConnection()) {
      res();
      return;
    }
    const timer = setTimeout(() => {
      broker.offBrowserConnected(onConnect);
      rej(new Error(`extension did not connect within ${timeoutMs}ms`));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      res();
    };
    broker.onBrowserConnected(onConnect);
  });
}
