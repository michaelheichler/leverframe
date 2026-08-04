// Small request execution context/observer that gives every HTTP and
// WebSocket-backed inference entry point (proxy.ts, server/router.ts,
// sdk-adapter.ts, openai-adapter.ts, upstream-forward.ts,
// oauth/responses-websocket.ts) a single, shared owner for:
//
//   - the RequestLifecycle state machine (accepted → … → terminal),
//   - its four deadline classes (connect/header/idle/total),
//   - downstream disconnect / local shutdown cancellation,
//   - turning the eventual terminal outcome into a ProviderTransportError.
//
// Nothing here duplicates RequestLifecycle's transition logic. The context
// deliberately does NOT expose the underlying RequestLifecycle instance —
// only phase methods, `abortSignal`, `getSnapshot()`, and `canReplay()` are
// public, so every transition invariant (legal edges, terminal-once,
// deadline arming) stays owned by RequestLifecycle itself and cannot be
// bypassed by a call site reaching past the context.

import {
  RequestLifecycle,
  type LifecycleDeadlines,
  type LifecycleOutcome,
  type LifecycleState,
  type RetryAttemptRecord,
} from './request-lifecycle.js';
import {
  providerErrorForLifecycleOutcome,
} from './request-lifecycle-error-mapping.js';
import type { ProviderTransportError } from './provider-error.js';

export interface RequestExecutionContextOptions {
  requestId: string;
  /** Provider id used to label the mapped ProviderTransportError. */
  provider: string;
  model?: string;
  correlationId?: string;
  /** External signal (client disconnect, caller-driven cancellation) that cancels the lifecycle. */
  signal?: AbortSignal;
  /** Deadline overrides; production callers normally rely on RequestLifecycle's defaults. */
  deadlines?: LifecycleDeadlines;
}

export interface RequestExecutionSnapshot {
  state: LifecycleState;
  isTerminal: boolean;
  outputEmitted: boolean;
  toolCallEmitted: boolean;
}

/**
 * The narrow surface every transport/adapter call site is allowed to drive.
 * Structurally satisfied by `RequestLifecycle` itself, so nothing downstream
 * (`upstream-forward.ts`, `sdk-adapter.ts`, `openai-adapter.ts`) needs the
 * concrete class — only this observer shape.
 */
export interface RequestExecutionObserver {
  readonly abortSignal: AbortSignal;
  startResolving(): void;
  startConnecting(): void;
  markHeadersReceived(): void;
  markStreamActivity(): void;
  markOutputEmitted(): void;
  markToolCallEmitted(): void;
  recordRetryAttempt(record: Omit<RetryAttemptRecord, 'atMs'>): void;
  complete(): void;
  fail(error: unknown): void;
  cancel(origin?: 'local' | 'provider'): void;
}

export interface RequestExecutionContext extends RequestExecutionObserver {
  readonly requestId: string;
  /** Point-in-time view of lifecycle state — never a handle to mutate it. */
  getSnapshot(): RequestExecutionSnapshot;
  /** True while automatic retry/replay is still safe (nothing visible has reached the client). */
  canReplay(): boolean;
  /**
   * Once the lifecycle has reached a terminal state, maps the outcome to a
   * ProviderTransportError (undefined for a clean `completed` outcome, and
   * undefined before termination).
   */
  finish(attemptCount?: number): ProviderTransportError | undefined;
  /** Release timers/listeners; call in a `finally` around the request handler. */
  dispose(): void;
}

// Local-shutdown registry: every non-terminal lifecycle created through this
// module registers itself here so `cancelAllActiveRequestExecutions` (wired
// into each server's `close()`) can own the "local shutdown" cancellation
// edge without every call site tracking its own in-flight set.
const activeLifecycles = new Set<RequestLifecycle>();

/**
 * Registers `lifecycle` in the local-shutdown set and returns an idempotent
 * `untrack` callback. RequestLifecycle has no terminal-transition event, so
 * termination is observed via the same abortSignal every non-completed
 * outcome fires; a clean `complete()` untracks explicitly instead.
 */
function trackForShutdown(lifecycle: RequestLifecycle): () => void {
  activeLifecycles.add(lifecycle);
  const untrack = () => activeLifecycles.delete(lifecycle);
  if (lifecycle.isTerminal) untrack();
  else lifecycle.abortSignal.addEventListener('abort', untrack, { once: true });
  return untrack;
}

function buildObserverMethods(lifecycle: RequestLifecycle, untrack: () => void): RequestExecutionObserver {
  return {
    get abortSignal() {
      return lifecycle.abortSignal;
    },
    startResolving: () => lifecycle.startResolving(),
    startConnecting: () => lifecycle.startConnecting(),
    markHeadersReceived: () => lifecycle.markHeadersReceived(),
    markStreamActivity: () => lifecycle.markStreamActivity(),
    markOutputEmitted: () => lifecycle.markOutputEmitted(),
    markToolCallEmitted: () => lifecycle.markToolCallEmitted(),
    recordRetryAttempt: record => lifecycle.recordRetryAttempt(record),
    complete: () => {
      lifecycle.complete();
      untrack();
    },
    fail: error => lifecycle.fail(error),
    cancel: origin => lifecycle.cancel(origin),
  };
}

export function createRequestExecutionContext(
  options: RequestExecutionContextOptions,
): RequestExecutionContext {
  const lifecycle = new RequestLifecycle({
    requestId: options.requestId,
    correlationId: options.correlationId,
    deadlines: options.deadlines,
    signal: options.signal,
  });
  const untrack = trackForShutdown(lifecycle);

  const mapOutcome = (outcome: LifecycleOutcome, attemptCount?: number): ProviderTransportError | undefined =>
    providerErrorForLifecycleOutcome(outcome, {
      provider: options.provider,
      model: options.model,
      attemptCount,
    });

  return {
    requestId: options.requestId,
    ...buildObserverMethods(lifecycle, untrack),
    getSnapshot: () => ({
      state: lifecycle.state,
      isTerminal: lifecycle.isTerminal,
      outputEmitted: lifecycle.hasEmittedOutput,
      toolCallEmitted: lifecycle.hasEmittedToolCall,
    }),
    canReplay: () => lifecycle.canAutoReplay,
    finish(attemptCount) {
      const outcome = lifecycle.terminalOutcome;
      return outcome ? mapOutcome(outcome, attemptCount) : undefined;
    },
    dispose() {
      untrack();
      lifecycle.dispose();
    },
  };
}

/**
 * Cancels every request execution still in flight (local shutdown edge).
 * Call from each server's `close()` before/while tearing down the listener
 * so in-flight requests settle to a `cancelled` terminal outcome instead of
 * being abandoned mid-stream.
 */
export function cancelAllActiveRequestExecutions(): void {
  for (const lifecycle of activeLifecycles) lifecycle.cancel('local');
}

/** Test-only: number of lifecycles currently tracked as in flight. */
export function activeRequestExecutionCountForTests(): number {
  return activeLifecycles.size;
}
