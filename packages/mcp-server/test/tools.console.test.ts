import { describe, it, expect } from 'vitest';
import { consoleTools } from '../src/tools/console.js';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@browpilot/shared';

describe('console tool', () => {
  it('browser_console calls Method.GET_CONSOLE with filter/since/tabId and formats entries', async () => {
    const client = new FakeClient();
    client.onMethod(Method.GET_CONSOLE, {
      entries: [{ tabId: 1, level: 'error', text: 'boom', timestamp: 123 }],
    });
    const ctx = createContext(client);
    const t = consoleTools.find((d) => d.name === 'browser_console')!;
    const res = await t.handler({ tabId: 1, filter: 'error', since: 100 }, ctx);
    expect(client.last()).toMatchObject({
      method: Method.GET_CONSOLE,
      params: { tabId: 1, filter: 'error', since: 100 },
    });
    expect((res.content[0] as { text: string }).text).toContain('boom');
  });
});
