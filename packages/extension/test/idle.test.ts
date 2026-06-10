import { describe, expect, it, vi } from 'vitest';
import { IdleDetacher } from '../src/background/idle';

/** A clock the test drives by hand, so idle timing is deterministic (no real timers). */
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const MIN = 60_000;

describe('IdleDetacher', () => {
  it('does not detach before the idle window elapses', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);
    idle.noteAttached(7);

    clock.advance(29 * MIN);
    const detached = await idle.check(30 * MIN);

    expect(detached).toEqual([]);
    expect(detach).not.toHaveBeenCalled();
  });

  it('detaches every attached tab once idle past the window', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);
    idle.noteAttached(7);
    idle.noteAttached(8);

    clock.advance(30 * MIN);
    const detached = await idle.check(30 * MIN);

    expect(detached.sort()).toEqual([7, 8]);
    expect(detach).toHaveBeenCalledWith(7);
    expect(detach).toHaveBeenCalledWith(8);
  });

  it('recordActivity resets the idle countdown', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);
    idle.noteAttached(7);

    clock.advance(29 * MIN);
    idle.recordActivity(); // fresh activity just before the deadline
    clock.advance(29 * MIN);
    const detached = await idle.check(30 * MIN);

    expect(detached).toEqual([]);
    expect(detach).not.toHaveBeenCalled();
  });

  it('is disabled when idleMs <= 0', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);
    idle.noteAttached(7);

    clock.advance(10 * 60 * MIN);
    expect(await idle.check(0)).toEqual([]);
    expect(detach).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing is attached', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);

    clock.advance(10 * 60 * MIN);
    expect(await idle.check(30 * MIN)).toEqual([]);
    expect(detach).not.toHaveBeenCalled();
  });

  it('marks idle-detached tabs for reattach suppression, cleared by a fresh attach', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);
    idle.noteAttached(7);

    clock.advance(30 * MIN);
    await idle.check(30 * MIN);
    expect(idle.shouldSuppressReattach(7)).toBe(true);

    idle.noteAttached(7); // next tool call re-attaches -> re-arm auto-reattach
    expect(idle.shouldSuppressReattach(7)).toBe(false);
  });

  it('noteDetached drops a tab so it is not idle-detached', async () => {
    const clock = fakeClock();
    const detach = vi.fn(async () => {});
    const idle = new IdleDetacher(detach, clock.now);
    idle.noteAttached(7);
    idle.noteAttached(8);
    idle.noteDetached(7);

    clock.advance(30 * MIN);
    const detached = await idle.check(30 * MIN);

    expect(detached).toEqual([8]);
    expect(detach).not.toHaveBeenCalledWith(7);
  });
});
