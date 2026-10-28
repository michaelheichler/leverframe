// Because API keys reject cache_control.scope, a subscription-only field.
export function withoutCacheControlScope<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutCacheControlScope) as T;
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    key === 'cache_control' ? cacheControlWithoutScope(child) : withoutCacheControlScope(child),
  ]);
  return Object.fromEntries(entries) as T;
}

function cacheControlWithoutScope(cacheControl: unknown): unknown {
  if (!cacheControl || typeof cacheControl !== 'object' || Array.isArray(cacheControl)) return cacheControl;
  const { scope: _scope, ...rest } = cacheControl as Record<string, unknown>;
  return rest;
}
