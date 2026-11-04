export const SELECTOR_ATTEMPT_HEADER = 'x-leverframe-routing-selector-attempt';
export const SELECTOR_SESSION_HEADER = 'x-leverframe-selector-session';
export const SELECTOR_CONSUMER_HEADER = 'x-leverframe-selector-consumer';
export const SELECTOR_CONNECTION_HEADER = 'x-leverframe-selector-connection';

export function createSelectorAttemptFetch(beforeSend?: () => void, onSend?: () => void): typeof fetch {
  let dispatched = false;
  return async (input, init) => {
    if (dispatched) throw new Error('Selector inference attempt limit reached.');
    beforeSend?.();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw new Error('Selector inference was cancelled.');
    dispatched = true;
    onSend?.();
    return fetch(input, { ...init, redirect: 'error' });
  };
}

export function supportsSelectorSdkTransport(npm: string | undefined, providerId: string): boolean {
  if (providerId === 'antigravity' || providerId === 'github-copilot') return false;
  return npm === '@ai-sdk/openai' || npm === '@ai-sdk/openai-compatible' || npm === '@ai-sdk/anthropic';
}
