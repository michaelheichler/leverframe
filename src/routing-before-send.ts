import { AsyncLocalStorage } from 'node:async_hooks';

export interface RoutingBeforeSend {
  verify: () => Promise<void>;
  check: () => void;
}

const routingSendScope = new AsyncLocalStorage<RoutingBeforeSend>();

export function withRoutingBeforeSend<T>(guard: RoutingBeforeSend, operation: () => T): T {
  return routingSendScope.run(guard, operation);
}

export function routingGuardedFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const guard = routingSendScope.getStore();
    if (guard) {
      await guard.verify();
      guard.check();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) throw new Error('The routing attempt was cancelled or timed out.');
    }
    return base(input, init);
  };
}
