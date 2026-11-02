/** Because invalid translated cache directives must be rejected before fetch. */
import { afterEach, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

const fetchSlot = vi.hoisted(() => ({ current: undefined as typeof fetch | undefined }));

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: { apiKey: string; modelId: string }) => {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey: spec.apiKey,
        baseURL: 'https://api.anthropic.fixture/v1',
        fetch: (...args) => fetchSlot.current!(...args),
      })(spec.modelId);
    }),
  };
});

useIsolatedTestHome('leverframe-anthropic-cache-validation');

let server: ServerHandle | undefined;
const clientToken = 'gateway-client-fixture-sentinel';

afterEach(async () => {
  fetchSlot.current = undefined;
  await server?.close();
  server = undefined;
  vi.clearAllMocks();
});

function copilotModel(): ServerModelInfo {
  return {
    id: 'fixture-copilot-anthropic', name: 'fixture Copilot Claude', isFree: false, brand: 'Other',
    sourceBackend: 'github-copilot', modelFormat: 'anthropic', providerId: 'github-copilot',
    authType: 'oauth', npm: '@ai-sdk/anthropic', apiKey: 'copilot-oauth-fixture-sentinel',
  };
}

async function startRoute(): Promise<ServerHandle> {
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: clientToken, serverPassword: null,
    catalog: createGatewayModelCatalog([copilotModel()]),
  });
  return server;
}

const invalidDirectives = [
  { label: 'top-level cache type', directive: { cache_control: { type: 'persistent' } } },
  { label: 'top-level cache TTL', directive: { cache_control: { type: 'ephemeral', ttl: '2h' } } },
  { label: 'false cache value', directive: { cache_control: false } },
  { label: 'zero cache value', directive: { cache_control: 0 } },
  { label: 'system-block cache type', directive: { system: [{ type: 'text', text: 'instructions', cache_control: { type: 'persistent' } }] } },
  { label: 'message-block cache TTL', directive: { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture', cache_control: { type: 'ephemeral', ttl: '2h' } }] }] } },
  { label: 'tool cache type', directive: { tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'persistent' } }] } },
] as const;

it.each(invalidDirectives)('rejects an invalid $label without contacting the SDK upstream', async ({ directive }) => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'fixture-message', type: 'message', role: 'assistant', model: 'fixture-copilot-anthropic',
    content: [{ type: 'text', text: 'unexpected provider response' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  fetchSlot.current = upstream;
  const route = await startRoute();
  const response = await fetch(`${route.url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture-copilot-anthropic', max_tokens: 8,
      messages: [{ role: 'user', content: 'offline validation fixture' }],
      ...directive,
    }),
  });
  const payload = await response.json() as { error?: { type?: string } };

  expect(response.status).toBe(400);
  expect(payload.error?.type).toBe('invalid_request_error');
  expect(upstream).not.toHaveBeenCalled();
});

it('accepts null cache directives as absent markers', async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'fixture-message', type: 'message', role: 'assistant', model: 'fixture-copilot-anthropic',
    content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  fetchSlot.current = upstream;
  const route = await startRoute();
  const response = await fetch(`${route.url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture-copilot-anthropic', max_tokens: 8,
      cache_control: null,
      system: [{ type: 'text', text: 'fixture instructions', cache_control: null }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture prompt', cache_control: null }] }],
    }),
  });

  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});
