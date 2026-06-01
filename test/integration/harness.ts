import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, type LaunchedChrome } from 'chrome-launcher';
import { readPinnedExtensionId } from '../../scripts/lib/manifest.js';
import { DEFAULT_PORT, Method, type Config } from '@claude-browser/shared';
// R1: Broker exposes an in-process server factory via `startServer` (not `createServer`).
// R4: client + tool registration come from the mcp-server package.
import { startServer, type BrokerServer } from '@claude-browser/broker';
import { createClient, registerTools, type BrokerClient, type McpToolRegistrar } from '@claude-browser/mcp-server';

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
  chrome: LaunchedChrome;
  broker: BrokerServer;
  client: BrokerClient;
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
}

const extensionDist = join(REPO_ROOT, 'packages', 'extension', 'dist');

export async function startHarness(): Promise<Harness> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'cb-harness-'));
  const userDataDir = join(tmpRoot, 'chrome-profile');
  await mkdir(userDataDir, { recursive: true });

  const extensionId = await readPinnedExtensionId(extensionDist);
  const token = 'integration-test-token-0000000000000000000000000000000000000000';

  // R1: use startServer (canonical export from @claude-browser/broker).
  // Bind to DEFAULT_PORT: a freshly loaded extension has empty chrome.storage and
  // dials DEFAULT_PORT, so the broker MUST listen there for the extension to find
  // it (an ephemeral port would never be discovered by the extension).
  const broker = await startServer({ port: DEFAULT_PORT, token, extensionId });
  const { port } = broker;
  const config: Config = { port, token, extensionId };

  let chrome: LaunchedChrome | undefined;
  let client: BrokerClient | undefined;
  try {
    // Headful Chrome: chrome.debugger + MV3 service workers are unreliable in
    // headless mode, so we launch a real window (CI must allow a display, e.g.
    // via Xvfb on Linux; on macOS dev machines this just opens a window).
    chrome = await launch({
      chromeFlags: [
        `--load-extension=${extensionDist}`,
        `--disable-extensions-except=${extensionDist}`,
        // Chrome 137+ disabled the --load-extension switch by default; this
        // feature flag re-enables it so the unpacked extension actually loads.
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
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
    client = await createClient({ port, token });
    registerInto(tools, client);

    // Wait until the extension has connected to the broker (status -> connected),
    // up to 15s, otherwise tool calls will all error with EXTENSION_DISCONNECTED.
    await waitForExtension(broker, 15_000);

    const internal: Internal = { tmpRoot, chrome, broker, client, tools };

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
        try { internal.client.close(); } catch { /* ignore */ }
        internal.tools.clear();
        internal.client = await createClient({ port: internal.broker.port, token });
        registerInto(internal.tools, internal.client);
      },
      async teardown() {
        try {
          internal.client.close();
        } catch {
          /* ignore */
        }
        try {
          await internal.broker.close();
        } catch {
          /* ignore */
        }
        try {
          // kill() is typed void — do not await a void return.
          internal.chrome.kill();
        } catch {
          /* ignore */
        }
        try {
          await rm(internal.tmpRoot, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    // If anything after broker startup fails (Chrome launch, client connect, or
    // extension timeout), clean up the already-started broker and Chrome to
    // prevent orphaned processes, then re-throw.
    client?.close();
    try { chrome?.kill(); } catch { /* ignore */ }
    await broker.close().catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}

/** Register the real browser_* tool handlers, capturing each into a map we can call. */
function registerInto(
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>,
  client: BrokerClient,
): void {
  // registerTools accepts McpToolRegistrar — a narrow structural interface that
  // covers only the registerTool surface registerAll actually uses. We pass a
  // capture-sink that satisfies that interface directly, with no escape cast.
  // Any future expansion of registerAll's use of server will surface here as a
  // type error rather than a silent runtime failure.
  const sink: McpToolRegistrar = {
    registerTool(name, _config, handler) {
      tools.set(name, handler as (args: Record<string, unknown>) => Promise<ToolResult>);
    },
  };
  registerTools(sink, client);
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
      // Deregister immediately so the callback does not fire again on subsequent
      // reconnections (e.g. after forceExtensionOffline in soak tests), which
      // would call res() on an already-settled Promise.
      broker.offBrowserConnected(onConnect);
      res();
    };
    broker.onBrowserConnected(onConnect);
  });
}

// ── Two-profile harness ─────────────────────────────────────────────────────

interface ProfileSummary { browserId: string; label: string; status: string }

export interface TwoProfileHarness {
  broker: BrokerServer;
  client: BrokerClient;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listProfiles(): Promise<ProfileSummary[]>;
  teardown(): Promise<void>;
}

function launchChrome(userDataDir: string): Promise<LaunchedChrome> {
  return launch({
    chromeFlags: [
      `--load-extension=${extensionDist}`,
      `--disable-extensions-except=${extensionDist}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-timer-throttling',
    ],
    userDataDir,
    ignoreDefaultFlags: false,
  });
}

async function waitForProfiles(broker: BrokerServer, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (broker.router.connectedBrowserIds().length >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `only ${broker.router.connectedBrowserIds().length}/${count} profiles connected within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Launch ONE broker + TWO Chrome instances (distinct user-data-dirs → distinct
 * instanceIds) + one agent client, so tests can list/select/route across profiles.
 */
export async function startTwoProfileHarness(): Promise<TwoProfileHarness> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'cb-harness-2p-'));
  const dirA = join(tmpRoot, 'profile-a');
  const dirB = join(tmpRoot, 'profile-b');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  const extensionId = await readPinnedExtensionId(extensionDist);
  const token = 'integration-test-token-0000000000000000000000000000000000000000';
  const broker = await startServer({ port: DEFAULT_PORT, token, extensionId });
  const { port } = broker;

  const chromes: LaunchedChrome[] = [];
  let client: BrokerClient | undefined;
  try {
    chromes.push(await launchChrome(dirA));
    chromes.push(await launchChrome(dirB));

    const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
    client = await createClient({ port, token });
    registerInto(tools, client);

    await waitForProfiles(broker, 2, 20_000);
    const liveClient = client;

    return {
      broker,
      client: liveClient,
      async callTool(name, args) {
        const fn = tools.get(name);
        if (!fn) throw new Error(`tool not registered: ${name}`);
        return fn(args);
      },
      async listProfiles() {
        const res = await liveClient.request<{ profiles: ProfileSummary[] }>(Method.LIST_PROFILES, {});
        return res.profiles;
      },
      async teardown() {
        try { liveClient.close(); } catch { /* ignore */ }
        try { await broker.close(); } catch { /* ignore */ }
        for (const c of chromes) { try { c.kill(); } catch { /* ignore */ } }
        try { await rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  } catch (err) {
    client?.close();
    for (const c of chromes) { try { c.kill(); } catch { /* ignore */ } }
    await broker.close().catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}
