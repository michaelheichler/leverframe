import { describe, expect, it, vi } from 'vitest';
import { ProviderRuntimeCache } from '../src/provider-runtime-cache.js';

describe('ProviderRuntimeCache', () => {
  it('returns one immutable initial generation without exposing secrets in its identity', () => {
    const cache = new ProviderRuntimeCache<object>();

    const first = cache.snapshot('openai\x1faccount-a\x1fmodel', 'secret-token');
    const second = cache.snapshot('openai\x1faccount-a\x1fmodel', 'different-seed-is-ignored');

    expect(second).toBe(first);
    expect(first).toMatchObject({ generation: 1 });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fingerprint).not.toContain('secret-token');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('single-flights concurrent handle construction for one credential generation', async () => {
    const cache = new ProviderRuntimeCache<object>();
    const credential = cache.snapshot('route', 'token-a');
    let resolveHandle: ((handle: object) => void) | undefined;
    const create = vi.fn(() => new Promise<object>(resolve => { resolveHandle = resolve; }));

    const first = cache.getHandle('route', credential, create);
    const second = cache.getHandle('route', credential, create);
    const handle = { generation: 'a' };
    resolveHandle?.(handle);

    await expect(first).resolves.toBe(handle);
    await expect(second).resolves.toBe(handle);
    expect(create).toHaveBeenCalledOnce();
  });

  it('single-flights refresh, publishes one new generation, and evicts the stale handle', async () => {
    const disposed: object[] = [];
    const rotations: Array<[number, number]> = [];
    const cache = new ProviderRuntimeCache<object>({
      disposeHandle: handle => { disposed.push(handle); },
      onCredentialRotated: (previous, current) => { rotations.push([previous.generation, current.generation]); },
    });
    const original = cache.snapshot('route', 'token-a');
    const oldHandle = { generation: 'a' };
    await cache.getHandle('route', original, async () => oldHandle);
    let releaseRefresh: ((token: string) => void) | undefined;
    const refresh = vi.fn(() => new Promise<string>(resolve => { releaseRefresh = resolve; }));

    const first = cache.refresh('route', 'token-a', refresh);
    const second = cache.refresh('route', 'token-a', refresh);
    releaseRefresh?.('token-b');
    const [firstGeneration, secondGeneration] = await Promise.all([first, second]);

    expect(firstGeneration).toBe(secondGeneration);
    expect(firstGeneration).toMatchObject({ generation: 2, credential: 'token-b' });
    expect(refresh).toHaveBeenCalledOnce();
    expect(disposed).toEqual([oldHandle]);
    expect(rotations).toEqual([[1, 2]]);

    const newHandle = { generation: 'b' };
    await expect(cache.getHandle('route', firstGeneration, async () => newHandle)).resolves.toBe(newHandle);
  });

  it('returns the already-published generation to a stale concurrent refresher', async () => {
    const cache = new ProviderRuntimeCache<object>();
    cache.snapshot('route', 'token-a');
    const current = await cache.adopt('route', 'token-a', 'token-b');
    const refresh = vi.fn(async () => 'token-c');

    const stale = await cache.refresh('route', 'token-a', refresh);

    expect(stale).toBe(current);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('single-flights concurrent credential adoption and publishes only the first rotation', async () => {
    let releaseDisposal: (() => void) | undefined;
    const disposalGate = new Promise<void>(resolve => { releaseDisposal = resolve; });
    const rotated = vi.fn();
    const cache = new ProviderRuntimeCache<object>({
      disposeHandle: async () => disposalGate,
      onCredentialRotated: rotated,
    });
    const original = cache.snapshot('route', 'token-a');
    await cache.getHandle('route', original, async () => ({ generation: 'a' }));

    const first = cache.adopt('route', 'token-a', 'token-b');
    const concurrent = cache.adopt('route', 'token-a', 'token-c');
    releaseDisposal?.();
    const [firstGeneration, concurrentGeneration] = await Promise.all([first, concurrent]);

    expect(concurrentGeneration).toBe(firstGeneration);
    expect(firstGeneration).toMatchObject({ generation: 2, credential: 'token-b' });
    expect(rotated).toHaveBeenCalledOnce();
  });

  it('canonicalizes a stale request snapshot before constructing a provider handle', async () => {
    const cache = new ProviderRuntimeCache<{ token: string }>();
    const stale = cache.snapshot('route', 'token-a');
    const current = await cache.adopt('route', 'token-a', 'token-b');
    const create = vi.fn(async credential => ({ token: credential.credential }));

    const handle = await cache.getHandle('route', stale, create);

    expect(handle).toEqual({ token: 'token-b' });
    expect(create).toHaveBeenCalledWith(current);
  });

  it('disposes all settled handles exactly once during shutdown', async () => {
    const disposeHandle = vi.fn(async () => undefined);
    const cache = new ProviderRuntimeCache<object>({ disposeHandle });
    const first = cache.snapshot('route-a', 'token-a');
    const second = cache.snapshot('route-b', 'token-b');
    const handleA = { id: 'a' };
    const handleB = { id: 'b' };
    await cache.getHandle('route-a', first, async () => handleA);
    await cache.getHandle('route-b', second, async () => handleB);

    await cache.dispose();
    await cache.dispose();

    expect(disposeHandle).toHaveBeenCalledTimes(2);
    expect(disposeHandle).toHaveBeenCalledWith(handleA);
    expect(disposeHandle).toHaveBeenCalledWith(handleB);
  });

  it('rejects handle access after shutdown starts', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cache = new ProviderRuntimeCache<object>({
      disposeHandle: async () => gate,
    });
    const credential = cache.snapshot('route', 'token-a');
    await cache.getHandle('route', credential, async () => ({ id: 'a' }));

    const disposing = cache.dispose();
    await expect(cache.getHandle('route', credential, async () => ({ id: 'b' })))
      .rejects.toThrow(/disposed|shutting down/i);
    release?.();
    await disposing;
  });

  it('waits for in-flight handle construction before disposing it', async () => {
    const disposeHandle = vi.fn(async () => undefined);
    const cache = new ProviderRuntimeCache<object>({ disposeHandle });
    const credential = cache.snapshot('route', 'token-a');
    let resolveHandle: ((handle: object) => void) | undefined;
    const pending = cache.getHandle('route', credential, () => (
      new Promise(resolve => { resolveHandle = resolve; })
    ));

    const disposing = cache.dispose();
    const handle = { id: 'late' };
    resolveHandle?.(handle);
    await pending;
    await disposing;

    expect(disposeHandle).toHaveBeenCalledWith(handle);
  });

  it('shares a concurrent refresh failure, retains the old generation, and permits a later retry', async () => {
    const disposed = vi.fn();
    const cache = new ProviderRuntimeCache<object>({ disposeHandle: disposed });
    const original = cache.snapshot('route', 'token-a');
    await cache.getHandle('route', original, async () => ({ generation: 'a' }));
    let rejectRefresh: ((error: Error) => void) | undefined;
    const refresh = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectRefresh = reject; }));

    const first = cache.refresh('route', 'token-a', refresh);
    const concurrent = cache.refresh('route', 'token-a', refresh);
    rejectRefresh?.(new Error('refresh failed'));

    await expect(first).rejects.toThrow('refresh failed');
    await expect(concurrent).rejects.toThrow('refresh failed');
    expect(refresh).toHaveBeenCalledOnce();
    expect(cache.snapshot('route', 'ignored')).toBe(original);
    expect(disposed).not.toHaveBeenCalled();

    const recovered = await cache.refresh('route', 'token-a', async () => 'token-b');
    expect(recovered).toMatchObject({ generation: 2, credential: 'token-b' });
    expect(disposed).toHaveBeenCalledOnce();
  });
});
