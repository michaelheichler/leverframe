import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { useIsolatedTestHome } from './isolated-test-home.js';
import { workspaceOrSessionHash } from '../src/checkpoint-store.js';
import { loadCheckpoint } from '../src/execution-checkpoint.js';
import { createLanguageModel } from '../src/provider-factory.js';
import * as requestPipeline from '../src/request-pipeline.js';

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return { ...actual, createLanguageModel: vi.fn(async () => ({})) };
});

useIsolatedTestHome('leverframe-route-boundaries');
afterEach(() => { vi.restoreAllMocks(); vi.mocked(createLanguageModel).mockReset(); });

it.each(['http', 'disconnect', 'initialize', 'translate'])('records an OpenAI %s failure durably', async failure => {
  const upstream = createServer((req, res) => {
    req.resume();
    if (failure === 'disconnect') { req.socket.destroy(); return; }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture upstream failure' } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  vi.mocked(createLanguageModel).mockImplementation(async () => {
    if (failure === 'initialize') throw new Error('fixture initialization failure');
    return {} as never;
  });
  const gateway = await startServer({ host: '127.0.0.1', port: 0, apiKey: 'fixture', serverPassword: null,
    catalog: createGatewayModelCatalog([{ id: 'alias', name: 'Alias', isFree: false, brand: 'Other', sourceBackend: 'zen',
      modelFormat: 'openai', apiBaseUrl: baseUrl,
      ...(failure === 'http' || failure === 'disconnect' ? { completionsUrl: `${baseUrl}/v1/chat/completions` } : { npm: '@ai-sdk/openai-compatible' }) }]) });
  try {
    const response = await fetch(`${gateway.url}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'alias', user: failure,
        messages: [{ role: 'user', content: failure === 'translate' ? [{ type: 'unsupported' }] : 'hello' }] }),
    });
    await response.text();
    expect(response.status).toBeGreaterThanOrEqual(500);
    const scopeHash = workspaceOrSessionHash(`session:${failure}`);
    const { listExecutions } = await import('../src/checkpoint-store.js');
    const executions = listExecutions().filter(entry => entry.scopeHash === scopeHash);
    expect(executions).toHaveLength(1);
    expect(loadCheckpoint(scopeHash, executions[0].executionId).generation).toBeGreaterThan(1);
  } finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

it.each(['openai', 'anthropic'] as const)('preserves %s response aliases for JSON and SSE', async format => {
  const detach = vi.fn();
  const wire = requestPipeline.wireClientDisconnectAbort;
  vi.spyOn(requestPipeline, 'wireClientDisconnectAbort').mockImplementation((...args) => {
    const connection = wire(...args);
    return { ...connection, detach: () => { detach(); connection.detach(); } };
  });
  const payload = format === 'openai'
    ? { object: 'chat.completion', model: 'upstream', choices: [] }
    : { type: 'message', model: 'upstream', content: [], usage: { input_tokens: 1, output_tokens: 1 } };
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (!body.stream) { res.end(JSON.stringify(payload)); return; }
    const event = format === 'openai' ? { ...payload, object: 'chat.completion.chunk' } : { type: 'message_start', message: payload };
    res.end(`data: ${JSON.stringify(event)}\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const gateway = await startServer({ host: '127.0.0.1', port: 0, apiKey: 'fixture', serverPassword: null,
    catalog: createGatewayModelCatalog([{ id: 'alias', upstreamModelId: 'upstream', name: 'Alias', isFree: false,
      brand: 'Other', sourceBackend: 'zen', modelFormat: format, baseUrl, completionsUrl: `${baseUrl}/v1/chat/completions` }]) });
  try {
    for (const stream of [false, true]) {
      const response = await fetch(`${gateway.url}/${format}/v1/${format === 'openai' ? 'chat/completions' : 'messages'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hello' }], stream, max_tokens: 10 }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"model":"alias"');
      expect(text).not.toContain('"model":"upstream"');
    }
    if (format === 'anthropic') expect(detach).toHaveBeenCalledTimes(2);
    const invalid = await fetch(`${gateway.url}/${format}/v1/${format === 'openai' ? 'chat/completions' : 'messages'}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'alias' }),
    });
    expect(invalid.status).toBe(400);
    await invalid.text();
  } finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
