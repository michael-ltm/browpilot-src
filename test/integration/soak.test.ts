import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, shouldRunBrowserTests, type Harness } from './harness.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

const maybe = shouldRunBrowserTests() ? describe : describe.skip;

/** Poll a tool call until it succeeds (isError falsy) or the deadline passes. */
async function waitForToolToWork(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
  deadlineMs: number,
): Promise<number> {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await harness.callTool(name, args);
      if (!res.isError) return Date.now() - start;
      lastErr = res.content.map((c) => c.text ?? '').join('');
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tool ${name} never recovered within ${deadlineMs}ms; last error: ${lastErr}`);
}

maybe('soak: auto-heal across extension offline + repeated MCP restarts', () => {
  let harness: Harness;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    harness = await startHarness();
    // Establish a known-good baseline: a tab navigated to the fixture.
    await harness.callTool('browser_new_tab', { url: fixture.url });
    await harness.callTool('browser_navigate', { url: fixture.url });
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
    await fixture?.close();
  });

  it('a baseline tool call works before any disruption', async () => {
    const res = await harness.callTool('browser_get_tabs', {});
    expect(res.isError).toBeFalsy();
  }, 30_000);

  it('recovers within ~30s after the extension link is forced offline', async () => {
    // Simulate service-worker death by dropping the broker's browser-side
    // socket. The extension's scheduleReconnect (5s setTimeout + 0.5min alarm)
    // must re-establish the connection automatically.
    harness.forceExtensionOffline();

    // Immediately after the drop, a call should either error (disconnected) or
    // queue; within the budget it must succeed with zero manual action.
    const recoveredInMs = await waitForToolToWork(harness, 'browser_get_tabs', {}, 30_000);
    expect(recoveredInMs).toBeLessThan(30_000);
  }, 45_000);

  it('survives killing + restarting the MCP client repeatedly (zero manual action)', async () => {
    for (let i = 0; i < 5; i++) {
      // Kill the ephemeral per-session agent client and spin up a fresh one,
      // exactly like a new Claude Code session attaching to the warm broker.
      await harness.restartMcpClient();

      // The broker outlived the restart, so the new client must work fast.
      const recoveredInMs = await waitForToolToWork(harness, 'browser_get_tabs', {}, 15_000);
      expect(recoveredInMs, `iteration ${i} should recover quickly`).toBeLessThan(15_000);

      // And a real CDP-backed call must work too, proving the warm extension
      // link is reused (not just the broker socket).
      const nav = await harness.callTool('browser_navigate', { url: fixture.url });
      expect(nav.isError, `navigate should work after restart ${i}`).toBeFalsy();
    }
  }, 120_000);

  it('still works after combining both failure modes', async () => {
    // Worst case: drop the extension AND restart the client at the same time.
    harness.forceExtensionOffline();
    await harness.restartMcpClient();
    const recoveredInMs = await waitForToolToWork(harness, 'browser_get_tabs', {}, 30_000);
    expect(recoveredInMs).toBeLessThan(30_000);
  }, 45_000);
});
