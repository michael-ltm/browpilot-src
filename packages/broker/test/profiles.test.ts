import { describe, it, expect } from 'vitest';
import { ProfileRegistry } from '../src/profiles.js';

function fixedClock() { let t = 1000; return () => (t += 1000); }

describe('ProfileRegistry', () => {
  it('records a new profile as connected with reconnectCount 0', () => {
    const r = new ProfileRegistry(fixedClock());
    expect(r.connected('id-a', 'Work')).toBe(false); // false = not a reconnect
    const info = r.get('id-a')!;
    expect(info).toMatchObject({ browserId: 'id-a', label: 'Work', status: 'connected', reconnectCount: 0, tabCount: 0 });
    expect(r.logs('id-a').map((e) => e.kind)).toEqual(['connect']);
  });

  it('treats same-id reconnect as reconnect and increments the count', () => {
    const r = new ProfileRegistry(fixedClock());
    r.connected('id-a', 'Work');
    r.disconnected('id-a');
    expect(r.connected('id-a', 'Work')).toBe(true);
    expect(r.get('id-a')!.reconnectCount).toBe(1);
    expect(r.logs('id-a').map((e) => e.kind)).toEqual(['connect', 'disconnect', 'reconnect']);
  });

  it('records errors and lists only what was registered', () => {
    const r = new ProfileRegistry(fixedClock());
    r.connected('id-a', 'A'); r.connected('id-b', 'B');
    r.recordError('id-a', 'boom');
    expect(r.get('id-a')!.lastError!.message).toBe('boom');
    expect(r.list().map((p) => p.browserId).sort()).toEqual(['id-a', 'id-b']);
    expect(r.connectedIds().sort()).toEqual(['id-a', 'id-b']);
  });

  it('caps the event log at 50 entries (keeps the most recent)', () => {
    const r = new ProfileRegistry(fixedClock());
    r.connected('id-a', 'A');
    for (let i = 0; i < 60; i++) r.recordError('id-a', `e${i}`);
    const logs = r.logs('id-a');
    expect(logs.length).toBe(50);
    expect(logs.at(-1)!.detail).toBe('e59');
  });
});
