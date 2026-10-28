import { describe, expect, it, jest } from "@jest/globals";
import { IdleRefreshScheduler } from "./idle-refresh-scheduler";

describe("IdleRefreshScheduler", () => {
  function createControlledScheduler(
    fire: () => void,
    overrides: {
      idleThresholdMs?: number;
      maxWaitMs?: number;
      pollIntervalMs?: number;
      startTime?: number;
    } = {},
  ) {
    let now = overrides.startTime ?? 0;
    let timeoutHandle = 0;
    const scheduled: Array<{ fn: () => void; ms: number; handle: number }> = [];
    const scheduler = new IdleRefreshScheduler(fire, {
      idleThresholdMs: overrides.idleThresholdMs ?? 2000,
      maxWaitMs: overrides.maxWaitMs ?? 10000,
      pollIntervalMs: overrides.pollIntervalMs ?? 2000,
      now: () => now,
      scheduleTimeout: (fn, ms) => {
        timeoutHandle++;
        scheduled.push({ fn, ms, handle: timeoutHandle });
        return timeoutHandle;
      },
      cancelTimeout: () => {
        // noop for these tests; the scheduler only cancels its own handle
      },
    });

    return {
      scheduler,
      get now() {
        return now;
      },
      set now(value: number) {
        now = value;
      },
      scheduled,
      advanceTo(t: number) {
        now = t;
      },
      runLastTimeout() {
        const last = scheduled[scheduled.length - 1];
        if (!last) {
          throw new Error("no scheduled timeout");
        }
        last.fn();
      },
    };
  }

  it("re-arms when a keystroke arrives before the idle threshold", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    c.runLastTimeout(); // t=0, not idle yet
    expect(fire).not.toHaveBeenCalled();
    expect(c.scheduled.length).toBe(2); // re-armed
  });

  it("fires once the user has been idle for the threshold", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    c.advanceTo(2500);
    c.runLastTimeout();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("postpones fire when activity happens inside the idle window", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    c.advanceTo(1500);
    c.runLastTimeout();
    expect(fire).not.toHaveBeenCalled();
    c.scheduler.noteActivity();
    c.advanceTo(3000);
    c.runLastTimeout();
    expect(fire).not.toHaveBeenCalled(); // still only 1500ms since last activity
    c.advanceTo(3500);
    c.runLastTimeout();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("forces fire at maxWait even if the user never goes idle", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    c.advanceTo(10500);
    c.runLastTimeout();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("coalesces many pending keys into one fire", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    for (let i = 0; i < 500; i++) {
      c.scheduler.markPending(`path-${i}`);
    }
    c.advanceTo(2500);
    c.runLastTimeout();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(c.scheduler.pendingCount()).toBe(0);
  });

  it("never fires and leaves no arm when pending is empty", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    c.scheduler.drain(); // simulate fire draining
    c.advanceTo(2500);
    // With no pending, the last timeout would not have been scheduled; our
    // drain helper does not clear the previously scheduled timeout, so the
    // scheduled array still contains one entry, but running it should be a
    // no-op.
    expect(c.scheduled.length).toBe(1);
    c.runLastTimeout();
    expect(fire).not.toHaveBeenCalled();
  });

  it("stop cancels pending work", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire);
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    c.scheduler.stop();
    c.advanceTo(2500);
    expect(c.scheduler.pendingCount()).toBe(0);
    expect(c.scheduler.hasPending()).toBe(false);
    c.runLastTimeout();
    expect(fire).not.toHaveBeenCalled();
  });

  it("exposes firstPendingAt anchored on the first markPending", () => {
    const fire = jest.fn();
    const c = createControlledScheduler(fire, { startTime: 1000 });
    c.scheduler.noteActivity();
    c.scheduler.markPending("a");
    expect(c.scheduler.firstPendingAt).toBe(1000);
    c.advanceTo(1500);
    c.scheduler.markPending("b");
    expect(c.scheduler.firstPendingAt).toBe(1000);
  });
});
