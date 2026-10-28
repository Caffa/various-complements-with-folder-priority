export type IdleRefreshSchedulerOptions = {
  idleThresholdMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
};

export class IdleRefreshScheduler {
  private idleThresholdMs: number;
  private maxWaitMs: number;
  private pollIntervalMs: number;
  private now: () => number;
  private scheduleTimeout: (fn: () => void, ms: number) => unknown;
  private cancelTimeout: (handle: unknown) => void;

  private pending = new Set<string>();
  private armTimerHandle: unknown | undefined;
  private lastFiredKeys: Set<string> | undefined;
  lastActivityAt: number;
  firstPendingAt?: number;

  constructor(
    private fire: () => void,
    opts: IdleRefreshSchedulerOptions = {},
  ) {
    this.idleThresholdMs = opts.idleThresholdMs ?? 2000;
    this.maxWaitMs = opts.maxWaitMs ?? 10000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.now = opts.now ?? (() => Date.now());
    this.scheduleTimeout =
      opts.scheduleTimeout ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return handle;
      });
    this.cancelTimeout =
      opts.cancelTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.lastActivityAt = this.now();
  }

  noteActivity(): void {
    this.lastActivityAt = this.now();
  }

  markPending(key: string): void {
    if (!this.pending.has(key)) {
      this.pending.add(key);
      if (this.firstPendingAt === undefined) {
        this.firstPendingAt = this.now();
      }
    }
    this.armLoop();
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingKeys(): ReadonlySet<string> {
    return this.pending;
  }

  drain(): Set<string> {
    if (this.lastFiredKeys) {
      const keys = this.lastFiredKeys;
      this.lastFiredKeys = undefined;
      return new Set(keys);
    }
    const keys = new Set(this.pending);
    this.pending.clear();
    this.firstPendingAt = undefined;
    return keys;
  }

  private armLoop(): void {
    if (this.armTimerHandle !== undefined) {
      return;
    }
    this.armTimerHandle = this.scheduleTimeout(
      () => this.check(),
      this.pollIntervalMs,
    );
  }

  private check(): void {
    if (this.pending.size === 0) {
      this.armTimerHandle = undefined;
      return;
    }

    const now = this.now();
    const idle = now - this.lastActivityAt >= this.idleThresholdMs;
    const late =
      this.firstPendingAt !== undefined &&
      now - this.firstPendingAt >= this.maxWaitMs;

    if (idle || late) {
      this.armTimerHandle = undefined;
      const snapshot = new Set(this.pending);
      this.lastFiredKeys = snapshot;
      this.pending.clear();
      this.firstPendingAt = undefined;
      this.fire();
    } else {
      this.armTimerHandle = this.scheduleTimeout(
        () => this.check(),
        this.pollIntervalMs,
      );
    }
  }

  stop(): void {
    if (this.armTimerHandle !== undefined) {
      this.cancelTimeout(this.armTimerHandle);
      this.armTimerHandle = undefined;
    }
    this.pending.clear();
    this.firstPendingAt = undefined;
  }
}
