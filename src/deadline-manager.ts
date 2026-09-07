

export interface TimerHandle {
  unref?: () => void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (typeof handle.unref === 'function') handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type DeadlineKind = 'connect' | 'header' | 'idle' | 'total';

export interface DeadlineManagerOptions {
  clock?: Clock;
  onDeadline: (kind: DeadlineKind) => void;
}

export class DeadlineManager {
  private readonly clock: Clock;
  private readonly onDeadline: (kind: DeadlineKind) => void;
  private readonly timers = new Map<DeadlineKind, TimerHandle>();

  constructor(options: DeadlineManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.onDeadline = options.onDeadline;
  }

  arm(kind: DeadlineKind, ms: number | undefined): void {
    this.clear(kind);
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return;
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(kind);
      this.onDeadline(kind);
    }, ms);
    this.timers.set(kind, handle);
  }

  reset(kind: DeadlineKind, ms: number | undefined): void {
    this.arm(kind, ms);
  }

  clear(kind: DeadlineKind): void {
    const handle = this.timers.get(kind);
    if (handle !== undefined) {
      this.clock.clearTimeout(handle);
      this.timers.delete(kind);
    }
  }

  clearAll(): void {
    for (const kind of this.timers.keys()) this.clear(kind);
  }
}
