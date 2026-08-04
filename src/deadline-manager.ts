// Provider-neutral timer port used by RequestLifecycle (and anything else
// that needs cancellable deadlines) without depending on Node's timer API
// directly. Keeping this as a separate port makes deadline behavior
// deterministically testable and keeps `request-lifecycle.ts` free of any
// transport/provider-specific knowledge.

export interface TimerHandle {
  unref?: () => void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real wall-clock time, backed by Node's global timers. Unrefs so armed deadlines never keep the process alive. */
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

/** Owns zero or more named, independently re-armable deadlines and fires a callback when one elapses. */
export class DeadlineManager {
  private readonly clock: Clock;
  private readonly onDeadline: (kind: DeadlineKind) => void;
  private readonly timers = new Map<DeadlineKind, TimerHandle>();

  constructor(options: DeadlineManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.onDeadline = options.onDeadline;
  }

  /** Arm (or re-arm) `kind` to fire after `ms`. A no-op when `ms` is undefined/invalid. */
  arm(kind: DeadlineKind, ms: number | undefined): void {
    this.clear(kind);
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) return;
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(kind);
      this.onDeadline(kind);
    }, ms);
    this.timers.set(kind, handle);
  }

  /** Re-arm an already-armed deadline (e.g. the idle deadline, once per received chunk). */
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
