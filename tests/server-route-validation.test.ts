import { afterEach, describe, expect, it } from 'vitest';
import { listExecutions } from '../src/checkpoint-store.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-route-validation');

const handles: ServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close();
});

describe('inference route preflight', () => {
  it('rejects an invalid endpoint before creating execution state', async () => {
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'test-key',
      serverPassword: null,
      catalog: createGatewayModelCatalog([{
        id: 'invalid-openai-endpoint',
        name: 'Invalid OpenAI Endpoint',
        isFree: false,
        brand: 'Test',
        sourceBackend: 'test',
        providerId: 'test',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        apiBaseUrl: 'not-a-url',
      }]),
    });
    handles.push(server);

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'invalid-openai-endpoint', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'Invalid provider apiBaseUrl: must be http:// or https://' },
    });
    expect(listExecutions()).toEqual([]);
  });
});
