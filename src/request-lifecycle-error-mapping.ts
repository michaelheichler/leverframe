// Adapter layer: turns a provider-neutral `LifecycleOutcome` into a
// `ProviderTransportError`. Kept out of `request-lifecycle.ts` on purpose —
// the lifecycle state machine must stay usable for any transport (or none)
// without importing provider/HTTP concepts; this module is where lifecycle
// semantics meet the error taxonomy.

import {
  classifyProviderErrorCategory,
  ProviderTransportError,
  type ProviderErrorCategory,
  type ProviderFailurePhase,
} from './provider-error.js';
import type { LifecycleOutcome, LifecycleState } from './request-lifecycle.js';

export interface LifecycleErrorMappingContext {
  provider: string;
  model?: string;
  /** Set when the failure/cancel happened mid-retry; folded into ProviderTransportError.attemptCount. */
  attemptCount?: number;
}

/** Maps a lifecycle state to the transport-error phase it corresponds to. */
export function phaseForLifecycleState(state: LifecycleState): ProviderFailurePhase {
  switch (state) {
    case 'accepted':
    case 'resolving':
    case 'connecting':
      return 'connect';
    case 'headers':
      return 'headers';
    case 'streaming':
    case 'tool-call-emitted':
      return 'stream';
    default:
      return 'completion';
  }
}

function categoryForDeadline(deadline: 'connect' | 'header' | 'idle' | 'total'): ProviderErrorCategory {
  switch (deadline) {
    case 'connect': return 'connect_timeout';
    case 'header': return 'header_timeout';
    case 'idle': return 'idle_timeout';
    case 'total': return 'total_timeout';
  }
}

/**
 * Converts a terminal, non-`completed` {@link LifecycleOutcome} into a
 * {@link ProviderTransportError}. Returns `undefined` for a `completed`
 * outcome, since there is nothing to report.
 */
export function providerErrorForLifecycleOutcome(
  outcome: LifecycleOutcome,
  context: LifecycleErrorMappingContext,
): ProviderTransportError | undefined {
  if (outcome.state === 'completed') return undefined;

  const phase = phaseForLifecycleState(outcome.priorState);
  const base = {
    provider: context.provider,
    model: context.model,
    phase,
    outputEmitted: outcome.outputEmitted,
    attemptCount: context.attemptCount,
  };

  if (outcome.reason?.kind === 'error' && ProviderTransportError.isInstance(outcome.reason.error)) {
    return outcome.reason.error;
  }

  if (outcome.reason?.kind === 'deadline') {
    const category = categoryForDeadline(outcome.reason.deadline);
    return new ProviderTransportError({
      ...base,
      category,
      retryable: outcome.reason.deadline !== 'total',
      safeMessage: `Request exceeded its ${outcome.reason.deadline} deadline.`,
    });
  }

  if (outcome.reason?.kind === 'cancelled') {
    const category: ProviderErrorCategory = outcome.reason.origin === 'local' ? 'local_shutdown' : 'cancellation';
    return new ProviderTransportError({
      ...base,
      category,
      retryable: false,
      safeMessage: outcome.reason.origin === 'local'
        ? 'Request cancelled locally.'
        : 'Request cancelled by provider.',
    });
  }

  const cause = outcome.reason?.kind === 'error' ? outcome.reason.error : undefined;
  return new ProviderTransportError({
    ...base,
    category: classifyProviderErrorCategory({ phase, cause }),
    cause,
    retryable: false,
    safeMessage: 'Request failed.',
  });
}
