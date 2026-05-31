import { describe, it, expect } from 'vitest';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';

describe('createContext', () => {
  it('exposes the client and an empty ref map', () => {
    const client = new FakeClient();
    const ctx = createContext(client);
    expect(ctx.client).toBe(client);
    expect(ctx.refs.size).toBe(0);
  });

  it('attach() sends Method.ATTACH with the tabId', async () => {
    const client = new FakeClient();
    const ctx = createContext(client);
    await ctx.attach(42);
    expect(client.last()).toMatchObject({ method: 'attach', params: { tabId: 42 } });
  });
});
