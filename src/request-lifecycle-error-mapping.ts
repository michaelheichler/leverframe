
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
  attemptCount?: number;
}
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
      retryable: true,
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
