import { describe, it, expect, afterAll } from 'vitest';
import { shouldRunBrowserTests, startTwoProfileHarness } from './harness.js';

const d = shouldRunBrowserTests() ? describe : describe.skip;
d('multi-profile e2e', () => {
  let h: Awaited<ReturnType<typeof startTwoProfileHarness>>;
  afterAll(async () => { await h?.teardown(); });

  it('lists two profiles, then drives a chosen one', async () => {
    h = await startTwoProfileHarness();
    const profiles = await h.listProfiles();
    expect(profiles.length).toBe(2);
    // selecting one and creating a tab there succeeds without AMBIGUOUS
    const sel = await h.callTool('browser_select_profile', { browserId: profiles[0].browserId });
    expect(sel.isError).toBeFalsy();
    const res = await h.callTool('browser_new_tab', {});
    expect(JSON.stringify(res.content)).toMatch(/opened tab/);
  });
});
