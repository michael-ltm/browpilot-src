import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, shouldRunBrowserTests, type Harness } from './harness.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

const maybe = shouldRunBrowserTests() ? describe : describe.skip;

maybe('e2e: navigate -> snapshot -> click_ref -> type -> screenshot -> console', () => {
  let harness: Harness;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    harness = await startHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
    await fixture?.close();
  });

  it('drives a full hybrid scenario end-to-end', async () => {
    // 1. New tab (broker helper via browser_new_tab).
    const newTab = await harness.callTool('browser_new_tab', { url: 'about:blank' });
    expect(newTab.isError).toBeFalsy();

    // 2. Navigate to the local fixture (Page.navigate via ATTACH).
    const nav = await harness.callTool('browser_navigate', { url: fixture.url });
    expect(nav.isError).toBeFalsy();

    // 3. Snapshot returns an accessibility tree with stable refs.
    const snap = await harness.callTool('browser_snapshot', {});
    expect(snap.isError).toBeFalsy();
    const snapText = snap.content.map((c) => c.text ?? '').join('\n');
    // R3: canonical ref token format is [refN] (e.g. [ref1]), NOT [ref=...].
    // Parse with /\[(ref\d+)\]/g — the capture group is the ref id passed to browser_click_ref.
    expect(snapText).toMatch(/Go/);
    const refMatch = snapText.match(/\[(ref\d+)\]/);
    expect(refMatch, `snapshot should contain a [refN] token:\n${snapText}`).not.toBeNull();

    // Find a ref whose line mentions the "Go" button; fall back to first ref.
    const goLine = snapText.split('\n').find((l) => /Go/.test(l) && /\[ref\d+\]/.test(l));
    const goRef = (goLine?.match(/\[(ref\d+)\]/) ?? refMatch!)[1];

    // 4. Click the button by ref (DOM.getBoxModel -> Input click at center).
    const click = await harness.callTool('browser_click_ref', { ref: goRef });
    expect(click.isError).toBeFalsy();

    // 5. Type into the input. Re-snapshot to get the input's ref, then fill.
    const snap2 = await harness.callTool('browser_snapshot', {});
    const snap2Text = snap2.content.map((c) => c.text ?? '').join('\n');
    // R3: use [refN] format when scanning the second snapshot for the Name input.
    const inputLine = snap2Text.split('\n').find((l) => /Name/.test(l) && /\[ref\d+\]/.test(l));
    expect(inputLine, `expected a Name input ref:\n${snap2Text}`).toBeDefined();
    const inputRef = inputLine!.match(/\[(ref\d+)\]/)![1];
    const fill = await harness.callTool('browser_fill', { ref: inputRef, value: 'Ada Lovelace' });
    expect(fill.isError).toBeFalsy();

    // Confirm the value landed via a read-back eval.
    const readBack = await harness.callTool('browser_eval', {
      expression: 'document.getElementById("name").value',
    });
    expect(readBack.content.map((c) => c.text ?? '').join('')).toContain('Ada Lovelace');

    // 6. Screenshot returns non-empty base64.
    const shot = await harness.callTool('browser_screenshot', {});
    expect(shot.isError).toBeFalsy();
    const imagePart = shot.content.find((c) => c.type === 'image' || typeof c.data === 'string');
    expect(imagePart, 'screenshot must return an image part').toBeDefined();
    const b64 = imagePart!.data ?? '';
    expect(b64.length).toBeGreaterThan(1000); // a real PNG is well over 1KB

    // 7. Console returns the message the fixture logged at load (+ on click).
    const consoleRes = await harness.callTool('browser_console', {});
    const consoleText = consoleRes.content.map((c) => c.text ?? '').join('\n');
    expect(consoleText).toContain('CB_FIXTURE_LOADED');
    expect(consoleText).toContain('CB_BUTTON_CLICKED');
  }, 90_000);
});
