/** Detach one tab's debugger. */
export type DetachFn = (tabId: number) => Promise<void> | void;
/** Monotonic-ish millisecond clock; injectable so idle timing is testable. */
export type Clock = () => number;

/**
 * Tracks CDP activity and, once the browser has been idle past a threshold,
 * detaches every tab we attached so Chrome's "started debugging this browser"
 * banner clears. The next tool call re-attaches transparently.
 *
 * One global idle window (any CDP command on any tab counts as activity); a
 * timeout detaches all attached tabs at once.
 */
export class IdleDetacher {
  private readonly attached = new Set<number>();
  /** Tabs we just idle-detached — one-shot flag so auto-reattach leaves them alone. */
  private readonly suppressed = new Set<number>();
  private lastActivity: number;

  constructor(
    private readonly detachFn: DetachFn,
    private readonly clock: Clock = () => Date.now(),
  ) {
    this.lastActivity = clock();
  }

  /** Reset the idle countdown — call on every CDP command. */
  recordActivity(): void {
    this.lastActivity = this.clock();
  }

  /** Record that we attached `tabId` (counts as activity + re-arms auto-reattach). */
  noteAttached(tabId: number): void {
    this.attached.add(tabId);
    this.suppressed.delete(tabId);
    this.lastActivity = this.clock();
  }

  /** Record that `tabId` is no longer attached (explicit detach or tab closed). */
  noteDetached(tabId: number): void {
    this.attached.delete(tabId);
  }

  /** True if we idle-detached this tab and it should NOT be auto-reattached. */
  shouldSuppressReattach(tabId: number): boolean {
    return this.suppressed.has(tabId);
  }

  /** Consume the one-shot suppression flag for `tabId`. */
  clearSuppressed(tabId: number): void {
    this.suppressed.delete(tabId);
  }

  /**
   * Detach every attached tab if idle for >= idleMs. No-op when disabled
   * (idleMs <= 0), nothing is attached, or the idle window has not elapsed.
   * Returns the tabIds it detached.
   */
  async check(idleMs: number): Promise<number[]> {
    if (idleMs <= 0 || this.attached.size === 0) return [];
    if (this.clock() - this.lastActivity < idleMs) return [];
    const tabs = [...this.attached];
    for (const tabId of tabs) {
      this.suppressed.add(tabId);
      this.attached.delete(tabId);
      try {
        await this.detachFn(tabId);
      } catch {
        /* best effort — the tab may already be gone */
      }
    }
    return tabs;
  }
}
