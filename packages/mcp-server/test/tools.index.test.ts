import { describe, it, expect } from 'vitest';
import { registerAll, allTools } from '../src/tools/index.js';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';

class RecorderServer {
  registered: Array<{ name: string; config: unknown }> = [];
  registerTool(name: string, config: unknown, _handler: unknown): void {
    this.registered.push({ name, config });
  }
}

describe('registerAll', () => {
  it('registers every browser_* tool exactly once with a description and inputSchema', () => {
    const server = new RecorderServer();
    const ctx = createContext(new FakeClient());
    registerAll(server as never, ctx);

    const names = server.registered.map((r) => r.name).sort();
    const expected = allTools.map((t) => t.name).sort();
    expect(names).toEqual(expected);
    // no duplicates
    expect(new Set(names).size).toBe(names.length);
    // every entry has a description + schema
    for (const r of server.registered) {
      const cfg = r.config as { description?: string; inputSchema?: unknown };
      expect(typeof cfg.description).toBe('string');
      expect(cfg.inputSchema).toBeDefined();
    }
  });

  it('includes the core v1 tool surface', () => {
    const names = allTools.map((t) => t.name);
    for (const expected of [
      'browser_screenshot', 'browser_click', 'browser_move', 'browser_type',
      'browser_press_key', 'browser_scroll', 'browser_drag',
      'browser_snapshot', 'browser_click_ref', 'browser_fill', 'browser_query',
      'browser_get_text', 'browser_eval',
      'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_wait',
      'browser_get_tabs', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab',
      'browser_console',
    ]) {
      expect(names).toContain(expected);
    }
    // v1 explicitly has NO browser_get_history tool
    expect(names).not.toContain('browser_get_history');
  });
});
