import type { ProfileInfo, ProfileEvent, ProfileStatus } from '@browpilot/shared';

const MAX_EVENTS = 50;

interface ProfileRecord {
  browserId: string;
  label: string;
  status: ProfileStatus;
  connectedAt: number;
  lastSeen: number;
  lastError?: { message: string; at: number };
  reconnectCount: number;
  tabCount: number;
  events: ProfileEvent[];
}

/** Tracks per-profile connection metadata and a bounded event log. */
export class ProfileRegistry {
  private readonly records = new Map<string, ProfileRecord>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Mark a profile connected. Returns true if this was a reconnect of a known id. */
  connected(browserId: string, label: string): boolean {
    const t = this.now();
    const existing = this.records.get(browserId);
    if (existing) {
      existing.label = label;
      existing.status = 'connected';
      existing.connectedAt = t;
      existing.lastSeen = t;
      existing.reconnectCount += 1;
      this.pushEvent(existing, 'reconnect');
      return true;
    }
    const rec: ProfileRecord = {
      browserId, label, status: 'connected', connectedAt: t, lastSeen: t,
      reconnectCount: 0, tabCount: 0, events: [],
    };
    this.records.set(browserId, rec);
    this.pushEvent(rec, 'connect');
    return false;
  }

  disconnected(browserId: string): void {
    const r = this.records.get(browserId);
    if (!r) return;
    r.status = 'disconnected';
    r.lastSeen = this.now();
    this.pushEvent(r, 'disconnect');
  }

  recordError(browserId: string, message: string): void {
    const r = this.records.get(browserId);
    if (!r) return;
    const at = this.now();
    r.lastError = { message, at };
    r.lastSeen = at;
    this.pushEvent(r, 'error', message);
  }

  touch(browserId: string): void {
    const r = this.records.get(browserId);
    if (r) r.lastSeen = this.now();
  }

  setTabCount(browserId: string, n: number): void {
    const r = this.records.get(browserId);
    if (r) r.tabCount = n;
  }

  list(): ProfileInfo[] {
    return [...this.records.values()].map(toInfo);
  }

  get(browserId: string): ProfileInfo | undefined {
    const r = this.records.get(browserId);
    return r ? toInfo(r) : undefined;
  }

  logs(browserId: string, limit: number = MAX_EVENTS): ProfileEvent[] {
    const r = this.records.get(browserId);
    return r ? r.events.slice(-limit) : [];
  }

  connectedIds(): string[] {
    return [...this.records.values()].filter((r) => r.status === 'connected').map((r) => r.browserId);
  }

  /** browserIds of connected profiles whose label matches exactly (for label-or-id resolution). */
  connectedByLabel(label: string): string[] {
    return [...this.records.values()]
      .filter((r) => r.status === 'connected' && r.label === label)
      .map((r) => r.browserId);
  }

  private pushEvent(r: ProfileRecord, kind: ProfileEvent['kind'], detail?: string): void {
    r.events.push(detail !== undefined ? { at: this.now(), kind, detail } : { at: this.now(), kind });
    if (r.events.length > MAX_EVENTS) r.events.shift();
  }
}

function toInfo(r: ProfileRecord): ProfileInfo {
  return {
    browserId: r.browserId, label: r.label, status: r.status,
    connectedAt: r.connectedAt, lastSeen: r.lastSeen, lastError: r.lastError,
    reconnectCount: r.reconnectCount, tabCount: r.tabCount,
  };
}
