import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { translateRequest } from '../src/sdk-adapter.js';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-antigravity-server');

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const sessionId = '11111111-1111-4111-8111-111111111111';

function postToGateway(port: number, modelId: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: modelId,
      system: 'Preserve this generated harness task instruction.',
      messages: [{ role: 'user', content: 'Continue the assigned task.' }],
      max_tokens: 128,
      stream: false,
    });
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/anthropic/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
        'x-claude-code-session-id': sessionId,
      },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function antigravityGatewayModel(): ServerModelInfo {
  return {
    id: 'gemini-3.1-pro-high', name: 'Gemini Pro', isFree: false, brand: 'Google',
    sourceBackend: 'antigravity', modelFormat: 'openai', npm: '@ai-sdk/google',
    providerId: 'antigravity', authType: 'oauth', oauthAccountId: 'account-a', apiKey: 'fixture-token',
  };
}

describe('Antigravity request translation', () => {
  it('carries a stable conversation identity and disables automatic request replay', () => {
    const params = translateRequest({
      model: 'gemini-3.1-pro-high',
      system: 'Follow the user’s task instructions exactly.',
      messages: [{ role: 'user', content: 'Continue the existing task.' }],
    }, '@ai-sdk/google', {
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      reasoningMetadata: { providerId: 'antigravity' },
    });

    expect(params.headers).toMatchObject({ 'x-leverframe-antigravity-session': '11111111-1111-4111-8111-111111111111' });
    expect(params.maxRetries).toBe(0);
    expect(params.instructions).toContain('Follow the user’s task instructions exactly.');
  });
});

describe('Antigravity gateway routing', () => {
  it('uses the subscription route and preserves the client session in the gateway server', async () => {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a',
    });
    let outboundBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Gateway response.' }] }, finishReason: 'STOP' }],
      } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const server = await startServer({
      host: '127.0.0.1', port: 0, apiKey: 'fixture', serverPassword: null,
      catalog: createGatewayModelCatalog([antigravityGatewayModel()]),
    });

    try {
      const response = await postToGateway(server.port, 'gemini-3.1-pro-high');
      const request = outboundBody?.['request'] as {
        sessionId?: string;
        systemInstruction?: { parts?: Array<{ text?: string }> };
      } | undefined;

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ content: [{ type: 'text', text: 'Gateway response.' }] });
      expect(request?.sessionId).toBe(sessionId);
      expect(request?.systemInstruction?.parts?.[0]?.text).toContain('Preserve this generated harness task instruction.');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
