// Provider-neutral request lifecycle (stabilization plan §7.2).
//
// Owns the legal state transitions for a single proxied request, the four
// deadline classes (connect/header/idle/total), cancellation linking, and
// timestamped terminal outcomes. This module knows nothing about providers,
// HTTP status codes, or transport errors — it only tracks *when* things
// happened and *why* a request stopped in provider-neutral terms. Turning a
// terminal outcome into a `ProviderTransportError` is the job of the
// adapter/infrastructure layer (see `request-lifecycle-error-mapping.ts`).

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
/**
 * Legal forward transitions. A request may always fail or be cancelled from
 * any non-terminal state; those two edges are enforced separately rather
 * than repeated in every row below.
 */
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
  /** Deadline for establishing the transport connection (TCP/TLS/WebSocket handshake start). */
  connectMs?: number;
  /** Deadline for receiving response headers after the connection is established. */
  headerMs?: number;
  /** Maximum gap allowed between stream events once streaming has started. */
  idleMs?: number;
  /** Overall wall-clock budget for the request from acceptance to completion. */
  totalMs?: number;
}

/** @why Malformed durations must retain the configured fallback. */
function deadlineFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
/** Production defaults shared by every HTTP and WebSocket inference path. */
export const DEFAULT_LIFECYCLE_DEADLINES: Readonly<Required<LifecycleDeadlines>> = {
  connectMs: deadlineFromEnv('LEVERFRAME_CONNECT_TIMEOUT_MS', 30_000),
  headerMs: deadlineFromEnv('LEVERFRAME_HEADER_TIMEOUT_MS', 60_000),
  idleMs: deadlineFromEnv('LEVERFRAME_IDLE_TIMEOUT_MS', 10 * 60_000),
  totalMs: deadlineFromEnv('LEVERFRAME_TOTAL_TIMEOUT_MS', 60 * 60_000),
};

export const AUTO_REPLAY_MAX_RETRIES_ENV = 'LEVERFRAME_AUTO_REPLAY_MAX_RETRIES';
export const DEFAULT_AUTO_REPLAY_MAX_RETRIES = 2;
const MAX_AUTO_REPLAY_MAX_RETRIES = 10;
/** Invalid values use the safe default. Excessive values are bounded to ten retries. */
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
  /** Caller-defined label (e.g. a provider-error category); this module does not interpret it. */
  reason?: string;
}
/** Why a lifecycle stopped, in terms this module can express without knowing about providers. */
export type LifecycleFailureReason =
  | { kind: 'deadline'; deadline: DeadlineKind }
  | { kind: 'cancelled'; origin: 'local' | 'provider' }
  | { kind: 'error'; error: unknown };

export interface LifecycleOutcome {
  state: 'completed' | 'failed' | 'cancelled';
  atMs: number;
  outputEmitted: boolean;
  toolCallEmitted: boolean;
  /** The last non-terminal state the request was in before it stopped. Useful for phase attribution. */
  priorState: LifecycleState;
  reason?: LifecycleFailureReason;
}

export interface RequestLifecycleOptions {
  requestId: string;
  correlationId?: string;
  deadlines?: LifecycleDeadlines;
  /** External signal (e.g. client disconnect) that cancels the lifecycle. */
  signal?: AbortSignal;
  clock?: Clock;
}
/**
 * Tracks one request end-to-end. Deadlines are exposed as an
 * {@link AbortSignal} so callers can pass them straight to `fetch` or timer
 * APIs; firing any of them cancels the whole lifecycle.
 */
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
  /** Deadline-linked abort signal; also fires on explicit cancel() or an external signal. */
  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  get hasEmittedOutput(): boolean {
    return this.outputEmitted;
  }

  get hasEmittedToolCall(): boolean {
    return this.toolCallEmitted;
  }
  /** Automatic replay is only safe while nothing visible has reached the client. */
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
  /** Transition to `to`. Throws {@link IllegalLifecycleTransitionError} on an illegal edge. */
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
  /** Mark request validation/routing as started. Safe to call once at an operation boundary. */
  startResolving(): void {
    if (this.state === 'accepted') this.transition('resolving');
  }
  /** Mark an upstream operation as dispatched. */
  startConnecting(): void {
    this.startResolving();
    if (this.state === 'resolving') this.transition('connecting');
  }
  /** Mark that the upstream accepted the operation and response headers are available. */
  markHeadersReceived(): void {
    if (this.isTerminal) return;
    this.startConnecting();
    if (this.state === 'connecting') this.transition('headers');
  }
  /** Mark one provider stream event and re-arm the idle deadline. */
  markStreamActivity(): void {
    if (this.isTerminal) return;
    this.markHeadersReceived();
    if (this.state === 'headers' || this.state === 'tool-call-emitted') {
      this.transition('streaming');
    } else if (this.state === 'streaming') {
      this.resetIdleDeadline();
    }
  }
  /** Mark that a tool call became externally visible; this permanently closes the replay barrier. */
  markToolCallEmitted(): void {
    if (this.isTerminal) return;
    this.markStreamActivity();
    this.toolCallEmitted = true;
    if (this.state === 'streaming') this.transition('tool-call-emitted');
  }
  /** Reset the idle deadline; call once per received stream chunk while streaming. */
  resetIdleDeadline(): void {
    this.deadlineManager.reset('idle', this.deadlines.idleMs);
  }
  /** Mark that visible output (text/content) has reached the client. */
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
  /** Cancel due to a local shutdown/client-disconnect (`local`) or an upstream cancel (`provider`). */
  cancel(origin: 'local' | 'provider' = 'local'): void {
    if (this.isTerminal) return;
    this.finish('cancelled', { kind: 'cancelled', origin });
  }
  /**
   * Marks the request as having completed successfully. Legal from any
   * non-terminal state: a clean completion cascades through whichever
   * intermediate phase transitions were not explicitly observed (e.g. a
   * provider/test double that never calls `markHeadersReceived`/
   * `markStreamActivity` before resolving) so callers never need to know
   * exactly which phase hooks an adapter happened to fire before declaring
   * success.
   */
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
  /** Release timers/listeners without changing state — used on process shutdown for already-terminal requests. */
  dispose(): void {
    this.deadlineManager.clearAll();
  }
}
