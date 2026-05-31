import type { ConsoleEntry, GetConsoleParams } from '@claude-browser/shared';

const DEFAULT_CAP = 1000;

/** Per-tab capped ring buffer of console entries, queried locally by the router. */
export class ConsoleBuffer {
  private readonly perTab = new Map<number, ConsoleEntry[]>();

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  push(entry: ConsoleEntry): void {
    let ring = this.perTab.get(entry.tabId);
    if (ring === undefined) {
      ring = [];
      this.perTab.set(entry.tabId, ring);
    }
    ring.push(entry);
    if (ring.length > this.cap) {
      ring.splice(0, ring.length - this.cap);
    }
  }

  clearTab(tabId: number): void {
    this.perTab.delete(tabId);
  }

  query(params: GetConsoleParams): ConsoleEntry[] {
    const { tabId, filter, since } = params;
    const needle = filter?.toLowerCase();
    const rings =
      tabId === undefined
        ? [...this.perTab.entries()]
        : ([[tabId, this.perTab.get(tabId) ?? []]] as [number, ConsoleEntry[]][]);

    const out: ConsoleEntry[] = [];
    for (const [, ring] of rings) {
      for (const e of ring) {
        if (since !== undefined && !(e.timestamp > since)) continue;
        if (needle !== undefined && !e.text.toLowerCase().includes(needle)) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }
}
