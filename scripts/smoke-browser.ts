/** Isolated real Chromium smoke test. Never uses the daily broker port/profile. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startServer, type BrokerServer } from '../packages/broker/src/server.js';
import { LocalBrowserManager } from '../packages/broker/src/local/index.js';
import { BrokerClient } from '../packages/mcp-server/src/client.js';
import { createContext } from '../packages/mcp-server/src/context.js';
import { registerAll } from '../packages/mcp-server/src/tools/index.js';
import { DeveloperBrowser } from '../packages/mcp-server/src/developer/index.js';
import { idFromManifestKey } from '../packages/mcp-server/src/bootstrap.js';

const directory = await mkdtemp(join(tmpdir(), 'browpilot-smoke-'));
const executable = process.env.BROWPILOT_TEST_BROWSER ?? '/usr/bin/chromium';
const extension = join(directory, 'extension');
const otherExtension = join(directory, 'other-extension');
const userDataDir = join(directory, 'profile');
await cp(resolve('packages/extension/dist'), extension, { recursive: true });
await mkdir(otherExtension);
await writeFile(join(otherExtension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Independent debug fixture', version: '1.0', background: { service_worker: 'worker.js' } }));
await writeFile(join(otherExtension, 'worker.js'), 'globalThis.browpilotDebugValue = 42; chrome.runtime.onInstalled.addListener(() => {});');
await mkdir(join(userDataDir, 'Default'), { recursive: true });
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
const extensionId = idFromManifestKey(manifest.key);
let broker: BrokerServer | undefined;
let child: ChildProcess | undefined;
let client: BrokerClient | undefined;
let sdk: Client | undefined;
let mcp: McpServer | undefined;
let dev: DeveloperBrowser | undefined;
let launches = 0;
async function waitUntil(check: () => Promise<boolean> | boolean, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Smoke test condition timed out');
}
async function launch(args: string[]) {
  launches++;
  child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--load-extension=${extension},${otherExtension}`, `--disable-extensions-except=${extension},${otherExtension}`, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  child.stderr?.on('data', data => { logs = (logs + String(data)).slice(-4000); });
  await once(child, 'spawn');
  child.on('exit', code => { if (code) console.error('Testing browser exit', code, logs); });
}
async function connectDev() {
  let port = 0;
  await waitUntil(async () => {
    try { port = Number((await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; } catch { return false; }
  });
  dev = new DeveloperBrowser();
  await dev.connect(port);
}
async function stopBrowser() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit');
  if (!dev) await connectDev();
  await dev!.command({ method: 'Browser.close' }).catch(() => {});
  await dev!.close(); dev = undefined;
  await exit;
  child = undefined;
  await waitUntil(() => !broker!.hasBrowserConnection());
}
const local = new LocalBrowserManager({ configDir: join(directory, 'config'), extensionIds: [extensionId], roots: [], connectedIds: () => broker?.router.connectedBrowserIds() ?? [], launch: (_exe, args) => launch(args) });
try {
  broker = await startServer({ port: 0, token: 'isolated-smoke-token', extensionId }, { localManager: local });
  const bg = await readFile(join(extension, 'background.js'), 'utf8');
  assert.match(bg, /var DEFAULT_PORT = 8787;/);
  await writeFile(join(extension, 'background.js'), bg.replace('var DEFAULT_PORT = 8787;', `var DEFAULT_PORT = ${broker.port};`));
  // Seed a real unpacked installation in a new test-only profile, then shut it down.
  await launch([`--user-data-dir=${userDataDir}`, '--profile-directory=Default', 'about:blank']);
  await waitUntil(() => broker!.hasBrowserConnection());
  console.log('PASS real extension handshake');
  await connectDev();
  const worker = (await dev!.targets()).find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
  assert(worker, 'Extension service worker is discoverable over direct CDP');
  const session = await dev!.attach(worker.targetId);
  const contexts = await dev!.contexts(session.sessionId);
  assert(contexts.length > 0);
  const evaluation = await dev!.command({ method: 'Runtime.evaluate', sessionId: session.sessionId, params: { expression: 'chrome.runtime.id', returnByValue: true } }) as { result: { value: string } };
  assert.equal(evaluation.result.value, extensionId);
  console.log('PASS extension Worker target / context / evaluate');
  const otherWorker = (await dev!.targets()).find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && !t.url.startsWith(`chrome-extension://${extensionId}/`));
  assert(otherWorker, 'Independent extension worker is discoverable');
  const otherSession = await dev!.attach(otherWorker.targetId);
  const otherContexts = await dev!.contexts(otherSession.sessionId);
  assert(otherContexts.length > 0);
  const otherEvaluation = await dev!.command({ method: 'Runtime.evaluate', sessionId: otherSession.sessionId, params: { expression: 'globalThis.browpilotDebugValue', contextId: otherContexts[0].id, returnByValue: true } }) as { result: { value: number } };
  assert.equal(otherEvaluation.result.value, 42);
  console.log('PASS independent extension Worker context / evaluate');
  await stopBrowser();
  const profile = await local.register({ browser: 'chromium', executable, userDataDir, label: 'Smoke profile' });
  console.log('Installation evidence:', profile.extension.state);
  assert(['enabled', 'installed'].includes(profile.extension.state));
  client = new BrokerClient({ port: broker.port, token: 'isolated-smoke-token', sessionId: 'smoke' });
  await client.connectWithRetry();
  mcp = new McpServer({ name: 'browpilot-smoke', version: '0.2.0' });
  registerAll(mcp, createContext(client));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  sdk = new Client({ name: 'browpilot-smoke-client', version: '1' });
  await sdk.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await sdk!.callTool({ name, arguments: args });
    if (result.isError) {
      console.error('Failed tool', name, 'connected profiles', broker!.router.connectedBrowserIds());
      await connectDev();
      const targets = await dev!.targets();
      console.error('Diagnostic targets', targets.map(t => ({ id: t.targetId, type: t.type, url: t.url })));
      for (const target of targets.filter(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`))) {
        const attached = await dev!.attach(target.targetId);
        console.error('Worker tabs diagnostic', await dev!.command({ method: 'Runtime.evaluate', sessionId: attached.sessionId, params: { expression: 'chrome.tabs.query({}).then(t => JSON.stringify(t))', awaitPromise: true, returnByValue: true } }));
      }
      for (const target of targets.filter(t => t.type === 'page')) {
        const attached = await dev!.attach(target.targetId);
        console.error('Page diagnostic', await dev!.command({ method: 'Runtime.evaluate', sessionId: attached.sessionId, params: { expression: 'document.body.innerText', returnByValue: true } }));
      }
    }
    assert(!result.isError, JSON.stringify(result));
    return result;
  };
  const opened = await call('browser_open_instance', { id: profile.id, timeoutMs: 15000 });
  assert.match(JSON.stringify(opened), /browserId/);
  console.log('PASS MCP cold launch / one-time pairing');
  await call('browser_get_tabs');
  const created = await call('browser_new_tab', { url: 'data:text/html,<title>Browpilot smoke</title><h1>Connected</h1>' });
  await waitUntil(async () => /Browpilot smoke/.test(JSON.stringify(await call('browser_get_tabs'))));
  console.log('PASS MCP tab creation / listing');
  const tabId = Number(JSON.stringify(created).match(/opened tab (\d+)/)?.[1]);
  assert(Number.isInteger(tabId) && tabId > 0);
  const snapshot = await call('browser_snapshot', { tabId });
  assert.match(JSON.stringify(snapshot), /Connected/);
  const screenshot = await call('browser_screenshot', { tabId });
  assert((screenshot.content as Array<{ type: string }>).some(item => item.type === 'image'));
  console.log('PASS MCP page snapshot / screenshot with reduced manifest permissions');
  await stopBrowser();
  await call('browser_get_tabs');
  assert.equal(launches, 3);
  console.log('PASS implicit restart of selected offline profile');
  const persisted = new LocalBrowserManager({ configDir: join(directory, 'config'), extensionIds: [extensionId], roots: [], connectedIds: () => broker!.router.connectedBrowserIds() });
  assert((await persisted.list())[0]?.connected);
  console.log('PASS persisted local/runtime profile binding');
} finally {
  await stopBrowser().catch(() => { child?.kill('SIGTERM'); });
  await dev?.close();
  await sdk?.close();
  await mcp?.close();
  client?.close();
  await broker?.close();
  await rm(directory, { recursive: true, force: true });
}
