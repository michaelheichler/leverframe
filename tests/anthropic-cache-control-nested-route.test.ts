/** Because private nested-cache metadata must stay out of inference logs. */
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';

const home = mkdtempSync(join(tmpdir(), 'leverframe-nested-cache-route-'));
const previousHome = process.env.LEVERFRAME_HOME;
process.env.LEVERFRAME_HOME = home;
const inferenceLogPath = join(home, 'inference.jsonl');
const gatewayToken = 'gateway-auth-fixture-sentinel';
const providerToken = 'copilot-auth-fixture-sentinel';

vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/url-security.js')>(),
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

let server: ServerHandle | undefined;

afterAll(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function copilotModel(): ServerModelInfo {
  return {
    id: 'fixture-copilot-anthropic', name: 'fixture Copilot Claude', isFree: false, brand: 'Other',
    sourceBackend: 'github-copilot', modelFormat: 'anthropic', providerId: 'github-copilot',
    authType: 'oauth', npm: '@ai-sdk/anthropic', apiKey: providerToken, baseUrl: 'https://api.githubcopilot.com',
  };
}

function postNestedRequest(port: number): Promise<number> {
  const body = JSON.stringify({
    model: 'fixture-copilot-anthropic', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_log_fixture', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_log_fixture', content: [
        { type: 'text', text: 'private fixture output', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'session' } },
      ] }] },
    ],
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/anthropic/v1/messages', method: 'POST',
      headers: {
        authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

it('does not write private transport metadata into the request lifecycle log', async () => {
  let sent: Request | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    sent = input instanceof Request ? new Request(input, init) : new Request(input, init);
    return Response.json({
      id: 'msg-log-fixture', type: 'message', role: 'assistant', model: 'fixture-copilot-anthropic',
      content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  vi.stubGlobal('fetch', fakeFetch);
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    inferenceLogPath, catalog: createGatewayModelCatalog([copilotModel()]),
  });

  const status = await postNestedRequest(server.port);
  const entries = readFileSync(inferenceLogPath, 'utf8');
  const upstream = await sent!.clone().json() as Record<string, unknown>;

  expect(status).toBe(200);
  expect(upstream).not.toHaveProperty('nativeToolResultContent');
  expect(entries).not.toContain('nativeToolResultContent');
});
