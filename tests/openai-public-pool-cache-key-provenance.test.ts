import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createModelCatalog } from '../src/server/models.js';
import { saveRegistry } from '../src/registry/io.js';

vi.mock('../src/registry/url-security.js', () => ({
  revalidateCustomEndpointUrl: vi.fn(async () => ({ ok: true })),
}));

const accountRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174120';
const poolToken = 'anthropic-pool-api-sentinel';
const catalogToken = 'catalog-snapshot-must-not-be-used';
const callerCacheKey = 'caller-cache-key-fixture';

interface CapturedRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;
let server: ServerHandle | undefined;

function savePoolAccount(): void {
  fakeKeyring.set(accountRef.slice('keyring:'.length), poolToken);
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'fixture Anthropic API', enabled: true,
      authType: 'api', authRef: accountRef, api: {}, addedAt: '2026-01-01',
      accounts: [{ id: 'pool-account', authRef: accountRef, enabled: true }],
    }],
  });
}

function responseFromOpenAi() {
  return Response.json({
    id: 'resp-pool-cache-fixture', object: 'response', created_at: 1, model: 'gpt-pool-fixture', status: 'completed',
    output: [{ id: 'msg-pool-cache-fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'fixture pooled response', annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 2 },
  });
}

async function sendWithSelectedEndpoint(baseURL: string): Promise<{ response: Response; upstream: CapturedRequest[] }> {
  const upstream: CapturedRequest[] = [];
  const upstreamFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    expect(new URL(request.url).origin + new URL(request.url).pathname).toBe(`${baseURL}/responses`);
    upstream.push({ headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> });
    return responseFromOpenAi();
  };
  const clientFetch = globalThis.fetch;
  vi.stubGlobal('fetch', upstreamFetch);
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-sentinel', serverPassword: null,
    catalog: createModelCatalog([{
      id: 'gpt-pool-fixture', name: 'fixture pooled OpenAI model', isFree: false, brand: 'OpenAI',
      sourceBackend: 'fixture', modelFormat: 'openai', providerId: 'anthropic-api', authType: 'api',
      npm: '@ai-sdk/openai', apiKey: catalogToken, apiBaseUrl: baseURL,
    }]),
  });
  const response = await clientFetch(`${server.url}/openai/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-pool-fixture', prompt_cache_key: callerCacheKey,
      messages: [{ role: 'user', content: 'offline cache key fixture' }] }),
  });
  return { response, upstream };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-openai-pool-cache-key-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = home;
  fakeKeyring = new Map();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it('forwards a caller cache key when the selected pooled SDK model targets canonical OpenAI', async () => {
  savePoolAccount();
  const { response, upstream } = await sendWithSelectedEndpoint('https://api.openai.com/v1');
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain('fixture pooled response');
  expect(upstream).toHaveLength(1);
  expect(upstream[0]!.headers.get('authorization')).toBe(`Bearer ${poolToken}`);
  expect(upstream[0]!.body.prompt_cache_key).toBe(callerCacheKey);
});

it('omits the caller cache key when the selected pooled SDK model targets a gateway', async () => {
  savePoolAccount();
  const { response, upstream } = await sendWithSelectedEndpoint('https://gateway.fixture/v1');
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain('fixture pooled response');
  expect(upstream).toHaveLength(1);
  expect(upstream[0]!.headers.get('authorization')).toBe(`Bearer ${poolToken}`);
  expect(upstream[0]!.body).not.toHaveProperty('prompt_cache_key');
});
