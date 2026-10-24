import { describe, it, expect } from 'vitest';
import { EventBuffer } from '../src/event-buffer.js';
import type { CdpEvent } from '@browpilot/shared';

const ev = (method: string, tabId: number, timestamp: number): CdpEvent => ({ method, tabId, timestamp, params: {} });

describe('EventBuffer', () => {
  it('filters by methodPrefix, tabId, since and limit', () => {
    const b = new EventBuffer();
    b.push(ev('Network.requestWillBeSent', 1, 100));
    b.push(ev('Network.responseReceived', 1, 200));
    b.push(ev('Debugger.paused', 1, 300));
    b.push(ev('Network.requestWillBeSent', 2, 400));

    expect(b.query({ methodPrefix: 'Network.' }).length).toBe(3);
    expect(b.query({ tabId: 1 }).length).toBe(3);
    expect(b.query({ methodPrefix: 'Network.', tabId: 1 }).length).toBe(2);
    expect(b.query({ since: 250 }).map((e) => e.method)).toEqual(['Debugger.paused', 'Network.requestWillBeSent']);
    expect(b.query({ limit: 1 }).length).toBe(1);
  });

  it('clearTab drops only that tab; clear empties everything', () => {
    const b = new EventBuffer();
    b.push(ev('Network.x', 1, 1));
    b.push(ev('Network.x', 2, 2));
    b.clearTab(1);
    expect(b.query({}).map((e) => e.tabId)).toEqual([2]);
    b.clear();
    expect(b.query({}).length).toBe(0);
  });

  it('evicts the oldest entries beyond the cap', () => {
    const b = new EventBuffer(3);
    for (let i = 0; i < 5; i++) b.push(ev('M', 1, i));
    expect(b.query({}).map((e) => e.timestamp)).toEqual([2, 3, 4]);
  });
});
