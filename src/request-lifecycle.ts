

import { type Clock, DeadlineManager, type DeadlineKind, systemClock } from './deadline-manager.js';

export type LifecycleState =
  | 'accepted'
  | 'resolving'
  | 'connecting'
  | 'headers'
  | 'streaming'
  | 'tool-call-emitted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type { DeadlineKind } from './deadline-manager.js';

const TERMINAL_STATES = new Set<LifecycleState>(['completed', 'failed', 'cancelled']);

const LEGAL_TRANSITIONS: Record<LifecycleState, ReadonlySet<LifecycleState>> = {
  accepted: new Set(['resolving']),
  resolving: new Set(['connecting']),
  connecting: new Set(['headers']),
  headers: new Set(['streaming', 'completed']),
  streaming: new Set(['tool-call-emitted', 'completed']),
  'tool-call-emitted': new Set(['streaming', 'completed']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export class IllegalLifecycleTransitionError extends Error {
  constructor(readonly from: LifecycleState, readonly to: LifecycleState) {
    super(`Illegal request lifecycle transition: ${from} -> ${to}`);
    this.name = 'IllegalLifecycleTransitionError';
  }
}

export interface LifecycleTransitionRecord {
  state: LifecycleState;
  atMs: number;
}

export interface LifecycleDeadlines {

  connectMs?: number;

  headerMs?: number;

  idleMs?: number;

  totalMs?: number;
}

function deadlineFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const DEFAULT_LIFECYCLE_DEADLINES: Readonly<Required<LifecycleDeadlines>> = {
  connectMs: deadlineFromEnv('LEVERFRAME_CONNECT_TIMEOUT_MS', 30_000),
  headerMs: deadlineFromEnv('LEVERFRAME_HEADER_TIMEOUT_MS', 60_000),
  idleMs: deadlineFromEnv('LEVERFRAME_IDLE_TIMEOUT_MS', 10 * 60_000),
  totalMs: deadlineFromEnv('LEVERFRAME_TOTAL_TIMEOUT_MS', 60 * 60_000),
};

export const AUTO_REPLAY_MAX_RETRIES_ENV = 'LEVERFRAME_AUTO_REPLAY_MAX_RETRIES';
export const DEFAULT_AUTO_REPLAY_MAX_RETRIES = 2;
const MAX_AUTO_REPLAY_MAX_RETRIES = 10;

export function autoReplayMaxRetries(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[AUTO_REPLAY_MAX_RETRIES_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_AUTO_REPLAY_MAX_RETRIES;
  return Math.min(Number(raw), MAX_AUTO_REPLAY_MAX_RETRIES);
}

export interface RetryAttemptRecord {
  attempt: number;
  atMs: number;

  reason?: string;
}

export type LifecycleFailureReason =
  | { kind: 'deadline'; deadline: DeadlineKind }
  | { kind: 'cancelled'; origin: 'local' | 'provider' }
  | { kind: 'error'; error: unknown };

export interface LifecycleOutcome {
  state: 'completed' | 'failed' | 'cancelled';
  atMs: number;
  outputEmitted: boolean;
  toolCallEmitted: boolean;

  priorState: LifecycleState;
  reason?: LifecycleFailureReason;
}

export interface RequestLifecycleOptions {
  requestId: string;
  correlationId?: string;
  deadlines?: LifecycleDeadlines;

  signal?: AbortSignal;
  clock?: Clock;
}

export class RequestLifecycle {
  readonly requestId: string;
  readonly correlationId?: string;
  readonly acceptedAtMs: number;

  private readonly clock: Clock;
  private readonly transitions: LifecycleTransitionRecord[] = [];
  private readonly retryAttempts: RetryAttemptRecord[] = [];
  private readonly deadlines: LifecycleDeadlines;
  private readonly controller = new AbortController();
  private readonly deadlineManager: DeadlineManager;
  private outputEmitted = false;
  private toolCallEmitted = false;
  private outcome: LifecycleOutcome | undefined;

  constructor(options: RequestLifecycleOptions) {
    this.requestId = options.requestId;
    this.correlationId = options.correlationId;
    this.clock = options.clock ?? systemClock;
    this.deadlines = { ...DEFAULT_LIFECYCLE_DEADLINES, ...options.deadlines };
    this.acceptedAtMs = this.clock.now();
    this.transitions.push({ state: 'accepted', atMs: this.acceptedAtMs });
    this.deadlineManager = new DeadlineManager({
      clock: this.clock,
      onDeadline: (kind) => this.onDeadlineFired(kind),
    });

    if (options.signal) {
      if (options.signal.aborted) {
        queueMicrotask(() => this.cancel('local'));
      } else {
        options.signal.addEventListener('abort', () => this.cancel('local'), { once: true });
      }
    }

    this.deadlineManager.arm('connect', this.deadlines.connectMs);
    this.deadlineManager.arm('total', this.deadlines.totalMs);
  }

  get state(): LifecycleState {
    return this.transitions[this.transitions.length - 1]!.state;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  get history(): readonly LifecycleTransitionRecord[] {
    return this.transitions;
  }

  get attempts(): readonly RetryAttemptRecord[] {
    return this.retryAttempts;
  }

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  get hasEmittedOutput(): boolean {
    return this.outputEmitted;
  }

  get hasEmittedToolCall(): boolean {
    return this.toolCallEmitted;
  }

  get canAutoReplay(): boolean {
    return !this.outputEmitted && !this.toolCallEmitted && !this.isTerminal;
  }

  get terminalOutcome(): LifecycleOutcome | undefined {
    return this.outcome;
  }

  private onDeadlineFired(kind: DeadlineKind): void {
    if (this.isTerminal) return;
    this.finish('failed', { kind: 'deadline', deadline: kind });
  }

  transition(to: LifecycleState): void {
    if (this.isTerminal) {
      throw new IllegalLifecycleTransitionError(this.state, to);
    }
    const from = this.state;
    const isFailOrCancel = to === 'failed' || to === 'cancelled';
    if (!isFailOrCancel && !LEGAL_TRANSITIONS[from].has(to)) {
      throw new IllegalLifecycleTransitionError(from, to);
    }
    this.transitions.push({ state: to, atMs: this.clock.now() });

    if (to === 'connecting') {
      this.deadlineManager.arm('header', this.deadlines.headerMs);
    }
    if (to === 'headers') {
      this.deadlineManager.clear('connect');
      this.deadlineManager.clear('header');
    }
    if (to === 'streaming') {
      this.resetIdleDeadline();
    }
    if (to === 'tool-call-emitted') {
      this.toolCallEmitted = true;
    }
    if (TERMINAL_STATES.has(to)) {
      this.settle(to as 'completed' | 'failed' | 'cancelled', from);
    }
  }

  startResolving(): void {
    if (this.state === 'accepted') this.transition('resolving');
  }

  startConnecting(): void {
    this.startResolving();
    if (this.state === 'resolving') this.transition('connecting');
  }

  markHeadersReceived(): void {
    if (this.isTerminal) return;
    this.startConnecting();
    if (this.state === 'connecting') this.transition('headers');
  }

  markStreamActivity(): void {
    if (this.isTerminal) return;
    this.markHeadersReceived();
    if (this.state === 'headers' || this.state === 'tool-call-emitted') {
      this.transition('streaming');
    } else if (this.state === 'streaming') {
      this.resetIdleDeadline();
    }
  }

  markToolCallEmitted(): void {
    if (this.isTerminal) return;
    this.markStreamActivity();
    this.toolCallEmitted = true;
    if (this.state === 'streaming') this.transition('tool-call-emitted');
  }

  resetIdleDeadline(): void {
    this.deadlineManager.reset('idle', this.deadlines.idleMs);
  }

  markOutputEmitted(): void {
    if (this.isTerminal) return;
    this.outputEmitted = true;
  }

  recordRetryAttempt(record: Omit<RetryAttemptRecord, 'atMs'>): void {
    this.retryAttempts.push({ ...record, atMs: this.clock.now() });
  }

  fail(error: unknown): void {
    if (this.isTerminal) return;
    this.finish('failed', { kind: 'error', error });
  }

  cancel(origin: 'local' | 'provider' = 'local'): void {
    if (this.isTerminal) return;
    this.finish('cancelled', { kind: 'cancelled', origin });
  }

  complete(): void {
    if (this.isTerminal) return;
    this.markHeadersReceived();
    this.transition('completed');
  }

  private finish(to: 'failed' | 'cancelled', reason: LifecycleFailureReason): void {
    const from = this.state;
    this.transitions.push({ state: to, atMs: this.clock.now() });
    this.settle(to, from, reason);
  }

  private settle(
    to: 'completed' | 'failed' | 'cancelled',
    priorState: LifecycleState,
    reason?: LifecycleFailureReason,
  ): void {
    this.deadlineManager.clearAll();
    this.outcome = {
      state: to,
      atMs: this.transitions[this.transitions.length - 1]!.atMs,
      outputEmitted: this.outputEmitted,
      toolCallEmitted: this.toolCallEmitted,
      priorState,
      reason,
    };
    if (to !== 'completed') this.controller.abort();
  }

  dispose(): void {
    this.deadlineManager.clearAll();
  }
}
