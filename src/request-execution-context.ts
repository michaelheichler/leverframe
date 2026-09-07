

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

  provider: string;
  model?: string;
  correlationId?: string;

  signal?: AbortSignal;

  deadlines?: LifecycleDeadlines;
}

export interface RequestExecutionSnapshot {
  state: LifecycleState;
  isTerminal: boolean;
  outputEmitted: boolean;
  toolCallEmitted: boolean;
}

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

  getSnapshot(): RequestExecutionSnapshot;

  canReplay(): boolean;

  finish(attemptCount?: number): ProviderTransportError | undefined;

  dispose(): void;
}

const activeLifecycles = new Set<RequestLifecycle>();

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

export function cancelAllActiveRequestExecutions(): void {
  for (const lifecycle of activeLifecycles) lifecycle.cancel('local');
}

export function activeRequestExecutionCountForTests(): number {
  return activeLifecycles.size;
}
