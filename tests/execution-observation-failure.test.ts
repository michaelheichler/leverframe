import { createObservationUpstream } from './execution-observation-upstream.js';
import { expect, it, vi } from 'vitest';
import { startProxyCatalog } from '../src/proxy.js';
import { startServer } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

const publicationFailure = vi.hoisted(() => vi.fn());
useIsolatedTestHome('leverframe-observation-failure');
vi.mock('../src/tool-call-ledger.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tool-call-ledger.js')>();
  return {
    ...actual,
    saveLedgerCAS: (input: Parameters<typeof actual.saveLedgerCAS>[0]) => {
      if (input.expectedCurrentGeneration > 0) {
        publicationFailure();
        throw new Error('Injected durable observation failure');
      }
      return actual.saveLedgerCAS(input);
    },
  };
});

it.each(['proxy', 'anthropic', 'openai'])('withholds successful %s responses when durable observation fails', async mode => {
  publicationFailure.mockClear();
  const { upstream, baseUrl } = await createObservationUpstream(mode);
  const handle = mode === 'proxy'
    ? await startProxyCatalog([{ aliasId: 'fake', realModelId: 'fake', displayName: 'Fake',
        upstreamUrl: baseUrl, apiKey: 'fake', modelFormat: 'anthropic', providerId: 'fake' }], 'fake', false)
    : await startServer({ host: '127.0.0.1', port: 0, apiKey: 'fake', serverPassword: null,
        catalog: createGatewayModelCatalog([{ id: 'fake', name: 'Fake', isFree: false, brand: 'Other',
          sourceBackend: 'zen', modelFormat: mode === 'openai' ? 'openai' : 'anthropic', baseUrl, completionsUrl: `${baseUrl}/v1/chat/completions` }]) });
  try {
    const response = await fetch(`http://127.0.0.1:${handle.port}${mode === 'openai' ? '/openai/v1/chat/completions' : mode === 'anthropic' ? '/anthropic/v1/messages' : '/v1/messages'}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...('token' in handle ? { authorization: `Bearer ${handle.token}` } : {}) },
      body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hello' }], stream: false, max_tokens: 10 }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    expect(publicationFailure).toHaveBeenCalledOnce();
    expect(response.status).toBe(mode === 'proxy' ? 502 : 500);
    expect(JSON.parse(body)).toMatchObject({ error: {
      type: 'api_error',
      message: `${mode === 'proxy' ? 'Error: ' : ''}Injected durable observation failure`,
    } });
    expect(body).not.toContain('"tool_use"');
    expect(body).not.toContain('"tool_calls"');
  } finally {
    await handle.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
