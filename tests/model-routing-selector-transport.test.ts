import { once } from 'node:events';
import * as http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { createRoutingSelectorCall } from '../src/proxy-routing-selector.js';
import type { SelectorPayload } from '../src/routing-selector.js';
import { input, nativeProviderWithRoutingMetadata, observation } from './model-routing-fixtures.js';

const capturedLoopbackFetch = globalThis.fetch.bind(globalThis);
type NativeSelectorOptions = NonNullable<Parameters<typeof createRoutingSelectorCall>[1]> & { fetch?: typeof fetch };

function blockDefaultFetch(): void {
  vi.stubGlobal('fetch', async () => { throw new Error('Default fetch is disabled in native selector fixtures.'); });
}

function nativeSelectorLoopbackFetch(localOrigin: URL): typeof fetch {
  return async (input, init) => {
    const requested = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (requested.origin !== 'https://api.anthropic.com') throw new Error('Native selector must use the canonical Anthropic origin.');
    const loopback = new URL(`${requested.pathname}${requested.search}`, localOrigin);
    if (loopback.hostname !== '127.0.0.1') throw new Error('Native selector test fetch must stay on loopback.');
    return capturedLoopbackFetch(loopback, init);
  };
}

afterEach(() => vi.unstubAllGlobals());

it('sends only the bounded selector payload to the internal adapter and parses its model reference', async () => {
  const selected = { providerId: 'fixture-worker-provider', modelId: 'fixture-worker-model' };
  let received: Record<string, unknown> | undefined;
  let authorization: string | undefined;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    received = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    authorization = req.headers['x-api-key'] as string | undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(selected) }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('selector adapter fixture did not bind');
  const target = { providerId: 'fixture-selector-provider', modelId: 'fixture-selector-model' };
  const payload: SelectorPayload = {
    category: 'review',
    effort: 'low',
    features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
    taskSignature: 'a'.repeat(64),
    candidates: [{ ref: selected, amount: 0.01 }, { ref: { providerId: 'another-provider', modelId: 'another-model' }, amount: 0.02 }],
    maxOutputTokens: 64,
  };
  const selectorCall = createRoutingSelectorCall(() => ({
    port: address.port,
    token: 'fixture-adapter-token',
    close() {},
  }));

  try {
    const result = await selectorCall(target, payload, new AbortController().signal);

    expect(result).toEqual(selected);
    expect(authorization).toBe('fixture-adapter-token');
    expect(received).toMatchObject({
      model: httpProxyModelId(target.providerId, target.modelId),
      stream: false,
      max_tokens: payload.maxOutputTokens,
    });
    expect(received?.messages).toEqual([{ role: 'user', content: JSON.stringify(payload) }]);
    expect(JSON.stringify(received)).not.toContain('raw task text');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('uses injected native OAuth credentials and the sourced model for selector traffic', async () => {
  const { native } = nativeProviderWithRoutingMetadata();
  const account = native.accounts![0]!;
  const ref = { providerId: native.id, modelId: account.modelsCache!.models[0]!.id };
  const catalog = buildRoutingCatalog(input([native], {
    credentials: [{ ...observation(native.id, 'oauth'), accountId: account.id }],
    discovery: [{ providerId: native.id, accountId: account.id, status: 'live', cacheFetchedAt: account.modelsCache!.fetchedAt }],
  }));
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    expect(body.model).toBe(account.modelsCache!.models[0]!.upstreamModelId);
    expect(req.headers.authorization).toBe('Bearer fixture-selector-oauth-token');
    expect(req.headers['x-api-key']).toBeUndefined();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ref) }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('native selector fixture did not bind');
  let credentialReads = 0;
  blockDefaultFetch();
  const selectorCall = createRoutingSelectorCall(() => {
    throw new Error('native selector traffic must not use the internal adapter');
  }, {
    catalog,
    origin: new URL('https://api.anthropic.com'),
    fetch: nativeSelectorLoopbackFetch(new URL(`http://127.0.0.1:${address.port}`)),
    readAuth: async () => {
      credentialReads++;
      return { kind: 'oauth', token: 'fixture-selector-oauth-token' };
    },
  } as NativeSelectorOptions);

  try {
    const result = await selectorCall(ref, {
      category: 'review',
      features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
      taskSignature: 'b'.repeat(64),
      candidates: [{ ref, amount: 0.01 }],
      maxOutputTokens: 32,
    }, new AbortController().signal);

    expect(result).toEqual(ref);
    expect(credentialReads).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('does not replay a native selector inference after a synthetic OAuth 401', async () => {
  const { native } = nativeProviderWithRoutingMetadata();
  const account = native.accounts![0]!;
  const model = account.modelsCache!.models[0]!;
  const ref = { providerId: native.id, modelId: model.id };
  const catalog = buildRoutingCatalog(input([native], {
    credentials: [{ ...observation(native.id, 'oauth'), accountId: account.id }],
    discovery: [{ providerId: native.id, accountId: account.id, status: 'live', cacheFetchedAt: account.modelsCache!.fetchedAt }],
  }));
  const requests: Array<{ model: string; authorization?: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
    requests.push({ model: String(body.model), authorization: req.headers.authorization });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'authentication_error' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('native selector fixture did not bind');
  let credentialReads = 0;
  blockDefaultFetch();
  const selectorCall = createRoutingSelectorCall(() => {
    throw new Error('native selector traffic must not use the internal adapter');
  }, {
    catalog,
    origin: new URL('https://api.anthropic.com'),
    fetch: nativeSelectorLoopbackFetch(new URL(`http://127.0.0.1:${address.port}`)),
    readAuth: async () => { credentialReads++; return { kind: 'oauth', token: 'fixture-selector-oauth-token' }; },
  } as NativeSelectorOptions);

  try {
    await expect(selectorCall(ref, { category: 'review', features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
      taskSignature: 'f'.repeat(64), candidates: [{ ref, amount: 0.01 }], maxOutputTokens: 32 },
    new AbortController().signal)).rejects.toThrow();

    expect(credentialReads).toBe(1);
    expect(requests).toEqual([{ model: model.upstreamModelId, authorization: 'Bearer fixture-selector-oauth-token' }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('rejects native selector traffic to a noncanonical origin before auth when no fetch is injected', async () => {
  const { native } = nativeProviderWithRoutingMetadata();
  const account = native.accounts![0]!;
  const ref = { providerId: native.id, modelId: account.modelsCache!.models[0]!.id };
  const catalog = buildRoutingCatalog(input([native], {
    credentials: [{ ...observation(native.id, 'oauth'), accountId: account.id }],
    discovery: [{ providerId: native.id, accountId: account.id, status: 'live', cacheFetchedAt: account.modelsCache!.fetchedAt }],
  }));
  let providerCalls = 0;
  const server = http.createServer((_req, res) => {
    providerCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ref) }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('native selector fixture did not bind');
  let credentialReads = 0;
  const selectorCall = createRoutingSelectorCall(() => {
    throw new Error('native selector traffic must not use the internal adapter');
  }, {
    catalog,
    origin: new URL(`http://127.0.0.1:${address.port}`),
    readAuth: async () => {
      credentialReads++;
      return { kind: 'oauth', token: 'fixture-selector-oauth-token' };
    },
  });

  try {
    await expect(selectorCall(ref, {
      category: 'review',
      features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
      taskSignature: 'e'.repeat(64),
      candidates: [{ ref, amount: 0.01 }],
      maxOutputTokens: 32,
    }, new AbortController().signal)).rejects.toThrow();
    expect(credentialReads).toBe(0);
    expect(providerCalls).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const nativeSelectorOriginCases: Array<{
  label: string;
  options: (input: {
    catalog: ReturnType<typeof buildRoutingCatalog>;
    origin: URL;
    readAuth: () => Promise<{ kind: 'oauth'; token: string }>;
    localOrigin: URL;
  }) => NativeSelectorOptions;
}> = [
  { label: 'without fetch injection', options: ({ catalog, origin, readAuth }) => ({ catalog, origin, readAuth }) },
  { label: 'even with fetch injection', options: ({ catalog, origin, readAuth, localOrigin }) => ({
    catalog, origin, readAuth, fetch: nativeSelectorLoopbackFetch(localOrigin),
  }) },
];

it.each(nativeSelectorOriginCases)('rejects native selector traffic to a noncanonical origin $label before auth', async ({ options }) => {
  const { native } = nativeProviderWithRoutingMetadata();
  const account = native.accounts![0]!;
  const ref = { providerId: native.id, modelId: account.modelsCache!.models[0]!.id };
  const catalog = buildRoutingCatalog(input([native], {
    credentials: [{ ...observation(native.id, 'oauth'), accountId: account.id }],
    discovery: [{ providerId: native.id, accountId: account.id, status: 'live', cacheFetchedAt: account.modelsCache!.fetchedAt }],
  }));
  let providerCalls = 0;
  const server = http.createServer((_req, res) => {
    providerCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ref) }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('native selector fixture did not bind');
  let credentialReads = 0;
  blockDefaultFetch();
  const selectorCall = createRoutingSelectorCall(() => {
    throw new Error('native selector traffic must not use the internal adapter');
  }, options({
    catalog,
    origin: new URL(`http://127.0.0.1:${address.port}`),
    localOrigin: new URL(`http://127.0.0.1:${address.port}`),
    readAuth: async () => {
      credentialReads++;
      return { kind: 'oauth', token: 'fixture-selector-oauth-token' };
    },
  }));

  try {
    await expect(selectorCall(ref, {
      category: 'review',
      features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
      taskSignature: 'e'.repeat(64),
      candidates: [{ ref, amount: 0.01 }],
      maxOutputTokens: 32,
    }, new AbortController().signal)).rejects.toThrow();
    expect(credentialReads).toBe(0);
    expect(providerCalls).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('aborts selector network dispatch when its caller has already cancelled', async () => {
  let adapterCalls = 0;
  const selectorCall = createRoutingSelectorCall(() => {
    adapterCalls++;
    return { port: 1, token: 'unused-fixture-token', close() {} };
  });
  const controller = new AbortController();
  controller.abort();

  await expect(selectorCall({ providerId: 'fixture-provider', modelId: 'fixture-model' }, {
    category: 'review',
    features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
    taskSignature: 'c'.repeat(64),
    candidates: [{ ref: { providerId: 'fixture-provider', modelId: 'fixture-model' }, amount: 0.01 }],
    maxOutputTokens: 32,
  }, controller.signal)).rejects.toThrow();
  expect(adapterCalls).toBe(0);
});

it.each([
  { label: 'an oversized serialized request', change: (payload: SelectorPayload) => ({ ...payload, category: 'x'.repeat(70_000) }) },
  { label: 'an output cap outside the supported range', change: (payload: SelectorPayload) => ({ ...payload, maxOutputTokens: 0 }) },
])('rejects $label before contacting the adapter', async ({ change }) => {
  let adapterCalls = 0;
  const selectorCall = createRoutingSelectorCall(() => {
    adapterCalls++;
    return { port: 1, token: 'unused-fixture-token', close() {} };
  });
  const payload: SelectorPayload = {
    category: 'review',
    features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
    taskSignature: 'd'.repeat(64),
    candidates: [{ ref: { providerId: 'fixture-provider', modelId: 'fixture-model' }, amount: 0.01 }],
    maxOutputTokens: 32,
  };

  await expect(selectorCall({ providerId: 'fixture-provider', modelId: 'fixture-model' }, change(payload), new AbortController().signal))
    .rejects.toThrow();
  expect(adapterCalls).toBe(0);
});
