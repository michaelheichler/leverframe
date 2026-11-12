import { setTimeout } from 'node:timers/promises';
import { isTransientAuthFailure } from './transient-auth.js';

const MAX_TRANSIENT_AUTH_RETRIES = 2;
const RETRY_BASE_MS = 250;

export function retryTransientAuth(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let attempt = 0; ; attempt++) {
      const response = await transport(input instanceof Request ? input.clone() : input, init);
      if (response.status !== 401 || attempt >= MAX_TRANSIENT_AUTH_RETRIES) return response;
      const body = await response.clone().text();
      if (!isTransientAuthFailure(response.status, body)) return response;
      await response.body?.cancel();
      const delay = RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_BASE_MS);
      await setTimeout(delay, undefined, { signal: signal ?? undefined });
    }
  };
}
