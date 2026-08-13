import { createHash } from 'node:crypto';

export interface CredentialSnapshot {
  readonly generation: number;
  readonly fingerprint: string;
  readonly credential: string;
}

interface HandleEntry<T> {
  readonly generation: number;
  readonly fingerprint: string;
  readonly promise: Promise<T>;
}

interface ProviderRuntimeCacheOptions<T> {
  disposeHandle?: (handle: T) => void | Promise<void>;
  onCredentialRotated?: (previous: CredentialSnapshot, current: CredentialSnapshot) => void | Promise<void>;
}

function fingerprintCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

function immutableSnapshot(generation: number, credential: string): CredentialSnapshot {
  return Object.freeze({
    generation,
    fingerprint: fingerprintCredential(credential),
    credential,
  });
}

/**
 * Owns immutable credential generations and the provider handles built from
 * them. Handle construction and rejected-token refresh are single-flight per
 * route, and a successful rotation makes every old-generation handle
 * unreachable before the new generation is published to callers.
 */
export class ProviderRuntimeCache<T> {
  private readonly credentials = new Map<string, CredentialSnapshot>();
  private readonly handles = new Map<string, HandleEntry<T>>();
  private readonly refreshes = new Map<string, Promise<CredentialSnapshot>>();
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: ProviderRuntimeCacheOptions<T> = {}) {}

  snapshot(routeKey: string, initialCredential: string): CredentialSnapshot {
    const current = this.credentials.get(routeKey);
    if (current) return current;
    const initial = immutableSnapshot(1, initialCredential);
    this.credentials.set(routeKey, initial);
    return initial;
  }

  async getHandle(
    routeKey: string,
    requestedCredential: CredentialSnapshot,
    create: (credential: CredentialSnapshot) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) throw new Error('Provider runtime cache has been disposed');
    // A caller may have captured a snapshot immediately before another request
    // rotated the route. Canonicalize it here so that stale request-local state
    // can never recreate a handle for an already-superseded generation.
    const credential = this.credentials.get(routeKey) ?? requestedCredential;
    const cacheKey = this.handleKey(routeKey, credential);
    const existing = this.handles.get(cacheKey);
    if (existing) return existing.promise;

    const promise = create(credential);
    this.handles.set(cacheKey, {
      generation: credential.generation,
      fingerprint: credential.fingerprint,
      promise,
    });
    promise.catch(() => {
      if (this.handles.get(cacheKey)?.promise === promise) this.handles.delete(cacheKey);
    });
    return promise;
  }

  async refresh(
    routeKey: string,
    rejectedCredential: string,
    refresh: () => Promise<string>,
  ): Promise<CredentialSnapshot> {
    return this.rotateSingleFlight(routeKey, rejectedCredential, refresh);
  }

  async adopt(
    routeKey: string,
    rejectedCredential: string,
    refreshedCredential: string,
  ): Promise<CredentialSnapshot> {
    return this.rotateSingleFlight(routeKey, rejectedCredential, async () => refreshedCredential);
  }

  private async rotateSingleFlight(
    routeKey: string,
    rejectedCredential: string,
    nextCredential: () => Promise<string>,
  ): Promise<CredentialSnapshot> {
    const rejectedFingerprint = fingerprintCredential(rejectedCredential);
    const current = this.credentials.get(routeKey);
    if (current && current.fingerprint !== rejectedFingerprint) return current;

    const existing = this.refreshes.get(routeKey);
    if (existing) return existing;

    const pending = (async () => {
      const before = this.snapshot(routeKey, rejectedCredential);
      if (before.fingerprint !== rejectedFingerprint) return before;
      return this.rotate(routeKey, before, await nextCredential());
    })();
    this.refreshes.set(routeKey, pending);
    try {
      return await pending;
    } finally {
      if (this.refreshes.get(routeKey) === pending) this.refreshes.delete(routeKey);
    }
  }

  private async rotate(
    routeKey: string,
    previous: CredentialSnapshot,
    refreshedCredential: string,
  ): Promise<CredentialSnapshot> {
    const latest = this.credentials.get(routeKey);
    if (latest && latest !== previous) return latest;
    if (previous.fingerprint === fingerprintCredential(refreshedCredential)) return previous;

    const current = immutableSnapshot(previous.generation + 1, refreshedCredential);
    // Removing stale entries and invoking the transport-eviction hook are both
    // synchronous up to the returned promises. Publish immediately afterward,
    // without an await gap in which an old snapshot could recreate stale state.
    const disposals = this.evictStaleHandles(routeKey, current);
    let transportEviction: void | Promise<void>;
    try {
      transportEviction = this.options.onCredentialRotated?.(previous, current);
    } catch (error) {
      transportEviction = Promise.reject(error);
    }
    this.credentials.set(routeKey, current);
    await Promise.all([...disposals, transportEviction]);
    return current;
  }

  private evictStaleHandles(routeKey: string, current: CredentialSnapshot): Promise<void>[] {
    const prefix = `${routeKey}\x1f`;
    const disposals: Promise<void>[] = [];
    for (const [key, entry] of this.handles) {
      if (!key.startsWith(prefix) || entry.fingerprint === current.fingerprint) continue;
      this.handles.delete(key);
      if (this.options.disposeHandle) {
        disposals.push(entry.promise.then(
          handle => this.options.disposeHandle?.(handle),
          () => undefined,
        ).then(() => undefined));
      }
    }
    return disposals;
  }

  /** Disposes every reachable provider handle and rejects later cache access. */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposed = true;
    const entries = [...this.handles.values()];
    this.handles.clear();
    this.credentials.clear();
    this.disposePromise = Promise.all(entries.map(entry => entry.promise.then(
      async handle => { await this.options.disposeHandle?.(handle); },
      () => undefined,
    ))).then(() => undefined);
    return this.disposePromise;
  }

  private handleKey(routeKey: string, credential: CredentialSnapshot): string {
    return `${routeKey}\x1f${credential.generation}\x1f${credential.fingerprint}`;
  }
}
