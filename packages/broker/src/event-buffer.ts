import type { CdpEvent, GetEventsParams } from '@claude-browser/shared';

const DEFAULT_CAP = 5000;

/**
 * Capped ring buffer of subscribed CDP events for one browser profile.
 * Unlike ConsoleBuffer this is a single ring (events are filtered by tabId on
 * read), because network/debugger analysis spans many resource ids per tab and
 * we want a global chronological view. Capped to bound memory on chatty pages.
 */
export class EventBuffer {
  private ring: CdpEvent[] = [];

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  push(e: CdpEvent): void {
    this.ring.push(e);
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap);
  }

  clear(): void {
    this.ring = [];
  }

  clearTab(tabId: number): void {
    this.ring = this.ring.filter((e) => e.tabId !== tabId);
  }

  query(params: GetEventsParams): CdpEvent[] {
    const { tabId, methodPrefix, since, limit } = params;
    let out = this.ring.filter(
      (e) =>
        (tabId === undefined || e.tabId === tabId) &&
        (methodPrefix === undefined || e.method.startsWith(methodPrefix)) &&
        (since === undefined || e.timestamp > since),
    );
    if (limit !== undefined && out.length > limit) out = out.slice(out.length - limit);
    return out;
  }
}
