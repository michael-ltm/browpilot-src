import { describe, it, expect } from 'vitest';
import { createContext, profileParam } from '../src/context.js';
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

  it('profileParam prefers explicit, then selected, else empty', () => {
    const ctx = createContext(new FakeClient());
    expect(profileParam(ctx)).toEqual({});
    ctx.selectedBrowserId = 'sel';
    expect(profileParam(ctx)).toEqual({ browserId: 'sel' });
    expect(profileParam(ctx, 'explicit')).toEqual({ browserId: 'explicit' });
  });

  it('attach forwards the resolved selectedBrowserId', async () => {
    const client = new FakeClient();
    const ctx = createContext(client);
    ctx.selectedBrowserId = 'b1';
    await ctx.attach(5);
    expect(client.last()).toMatchObject({ method: 'attach', params: { tabId: 5, browserId: 'b1' } });
  });
});
