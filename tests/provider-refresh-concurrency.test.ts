import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getProvidersPath } from '../src/paths.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { PRICING_API_URL } from '../src/registry/pricing.js';
import { refreshAllProviderModels } from '../src/registry/refresh-models.js';
import type { RegistryProvider } from '../src/registry/types.js';

afterEach(() => vi.unstubAllGlobals());

function provider(id: string): RegistryProvider {
  return {
    id, name: id, templateId: 'openai', authType: 'api', enabled: true,
    authRef: `env:${id.toUpperCase()}_KEY`,
    api: { npm: '@ai-sdk/openai' }, addedAt: '2026-11-19T00:00:00Z',
  };
}

function modelList(id: string): Response {
  return Response.json({ data: [{ id: `${id}-model` }] });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(complete => { resolve = complete; });
  return { promise, resolve };
}

function holdCatalogResponses(ids: string[]) {
  const requests: string[] = [];
  const responses = new Map(ids.map(id => [id, deferredResponse()]));
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input === PRICING_API_URL) return new Response(null, { status: 503 });
    const id = new Headers(init?.headers).get('authorization')?.replace(/^Bearer fixture-/, '');
    const pending = responses.get(id ?? '');
    if (input !== 'https://api.openai.com/v1/models' || !id || !pending) {
      throw new Error('Unexpected catalog request.');
    }
    requests.push(id);
    return pending.promise;
  });
  return { requests, responses };
}

it('refreshes independent provider catalogs with bounded concurrency and keeps registry order', async () => {
  const ids = ['fixture-one', 'fixture-two', 'fixture-three', 'fixture-four'];
  expect(getProvidersPath()).toBe(join(process.env.LEVERFRAME_TEST_HOME!, 'providers.json'));
  saveRegistry({ schemaVersion: 1, providers: ids.map(provider) });
  const { requests, responses } = holdCatalogResponses(ids);

  const refresh = refreshAllProviderModels(async entry => `fixture-${entry.id}`);
  await setImmediate();
  const firstRequests = [...requests];
  responses.get('fixture-three')!.resolve(modelList('fixture-three'));
  await setImmediate();
  const nextRequests = [...requests];
  responses.get('fixture-four')!.resolve(modelList('fixture-four'));
  responses.get('fixture-two')!.resolve(new Response(null, { status: 503 }));
  responses.get('fixture-one')!.resolve(modelList('fixture-one'));

  const { refreshed } = await refresh;
  expect(firstRequests).toEqual(['fixture-one', 'fixture-two', 'fixture-three']);
  expect(nextRequests).toEqual(ids);
  expect(requests).toEqual(ids);
  expect(refreshed.map(({ id, ok, modelSource }) => [id, ok, modelSource])).toEqual([
    ['fixture-one', true, 'live'],
    ['fixture-two', false, undefined],
    ['fixture-three', true, 'live'],
    ['fixture-four', true, 'live'],
  ]);
  expect(loadRegistry().providers.map(entry => entry.modelsCache?.models[0]?.id)).toEqual([
    'fixture-one-model', undefined, 'fixture-three-model', 'fixture-four-model',
  ]);
});
