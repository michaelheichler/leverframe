import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-antigravity-proxy');

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function postMessage(port: number, token: string, body: unknown, sessionId?: string, path = '/v1/messages'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: {
        'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(payload),
        ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}),
      },
    }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function antigravityRoute(): ProxyRoute {
  return {
    aliasId: 'antigravity:gemini-3.1-pro-high', realModelId: 'gemini-3.1-pro-high',
    displayName: 'Gemini Pro', upstreamUrl: '', apiKey: '', modelFormat: 'openai',
    npm: '@ai-sdk/google', providerId: 'antigravity', authType: 'oauth', oauthAccountId: 'account-a',
  };
}

async function proxySignedToolCycle(input: { port: number; token: string; modelId: string; sessionId: string }) {
  const tools = [{ name: 'inspect', description: 'Inspect a target.', input_schema: {
    type: 'object', properties: { target: { type: 'string' } }, required: ['target'],
  } }];
  const first = await postMessage(input.port, input.token, {
    model: input.modelId, messages: [{ role: 'user', content: 'Inspect example.' }], tools,
    max_tokens: 128, stream: false,
  }, input.sessionId);
  const firstBody = JSON.parse(first.body) as { content: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
  const toolCall = firstBody.content.find(item => item.type === 'tool_use')!;
  const second = await postMessage(input.port, input.token, {
    model: input.modelId,
    messages: [
      { role: 'user', content: 'Inspect example.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'The target exists.' }] },
    ],
    tools, max_tokens: 128, stream: false,
  }, input.sessionId);
  return { first, second, toolCall };
}

function signedToolReplies(signature: string): [unknown, unknown] {
  return [
    { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: {
      id: 'upstream-tool-call', name: 'inspect', args: { target: 'example' },
    }, thoughtSignature: signature }] }, finishReason: 'STOP' }] } },
    { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'The tool result was used.' }] }, finishReason: 'STOP' }] } },
  ];
}

describe('Leverframe Antigravity proxy', () => {
  it('passes harness instructions and user work through the subscription model route', async () => {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a',
    });
    let outboundBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Work completed.' }] }, finishReason: 'STOP' }],
      } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const route = antigravityRoute();
    const proxy = await startProxyCatalog([route], route.aliasId);

    try {
      const response = await postMessage(proxy.port, proxy.token, {
        model: route.aliasId,
        system: [
          { text: 'You are a coding agent. Follow the primary task carefully and preserve the repository workflow.' },
          { text: 'For delegated tasks, keep these instructions intact and report only the completed work.' },
        ],
        messages: [{ role: 'user', content: 'Inspect the requested implementation and complete it.' }],
        max_tokens: 128,
        stream: false,
      });
      const envelopeRequest = outboundBody?.['request'] as {
        systemInstruction?: { parts?: Array<{ text?: string }> };
        contents?: Array<{ parts?: Array<{ text?: string }> }>;
      } | undefined;

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ content: [{ type: 'text', text: 'Work completed.' }] });
      const instructions = envelopeRequest?.systemInstruction?.parts?.map(part => part.text).join('\n') ?? '';
      expect(instructions).toContain('Follow the primary task carefully');
      expect(instructions).toContain('For delegated tasks, keep these instructions intact');
      expect(envelopeRequest?.contents?.flatMap(message => message.parts ?? []).map(part => part.text))
        .toContain('Inspect the requested implementation and complete it.');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });
});

describe('Antigravity proxy tool continuation', () => {
  it('replays signed tool history through a later Antigravity subscription request', async () => {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a',
    });
    const requests: Array<Record<string, unknown>> = [];
    const signature = 'g'.repeat(4096);
    const capture = (body: unknown) => async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(body);
    };
    const [firstReply, secondReply] = signedToolReplies(signature);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(capture(firstReply))
      .mockImplementationOnce(capture(secondReply));
    vi.stubGlobal('fetch', fetchImpl);
    const route = antigravityRoute();
    const proxy = await startProxyCatalog([route], route.aliasId);

    try {
      const { first, second, toolCall } = await proxySignedToolCycle({
        port: proxy.port, token: proxy.token, modelId: route.aliasId,
        sessionId: '11111111-1111-4111-8111-111111111111',
      });
      const envelopeRequest = requests[1]?.['request'] as {
        contents?: Array<{ parts?: Array<Record<string, unknown>> }>;
      } | undefined;
      const parts = envelopeRequest?.contents?.flatMap(item => item.parts ?? []) ?? [];

      expect(first.status).toBe(200);
      expect(first.body).toContain('tool_use');
      expect(toolCall.id?.length).toBeLessThan(256);
      expect(second.status).toBe(200);
      expect(parts).toContainEqual(expect.objectContaining({
        functionCall: expect.objectContaining({ id: 'upstream-tool-call' }), thoughtSignature: signature,
      }));
      expect(parts).toContainEqual(expect.objectContaining({
        functionResponse: expect.objectContaining({ id: 'upstream-tool-call' }),
      }));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await proxy.close();
    }
  });
});

describe('Antigravity proxy system-message ordering', () => {
  it('hoists a late system message without losing prior user and assistant history', async () => {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a',
    });
    let outboundBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'History continued.' }] }, finishReason: 'STOP' }],
      } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const route = antigravityRoute();
    const proxy = await startProxyCatalog([route], route.aliasId);

    try {
      const response = await postMessage(proxy.port, proxy.token, {
        model: route.aliasId,
        system: 'Primary harness instruction.',
        messages: [
          { role: 'user', content: 'Earlier user turn.' },
          { role: 'assistant', content: 'Earlier assistant response.' },
          { role: 'system', content: 'Late harness instruction.' },
          { role: 'user', content: 'Current user turn.' },
        ],
        max_tokens: 128,
        stream: false,
      });
      const envelopeRequest = outboundBody?.['request'] as {
        systemInstruction?: { parts?: Array<{ text?: string }> };
        contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
      } | undefined;
      const instructions = envelopeRequest?.systemInstruction?.parts?.map(part => part.text).join('\n') ?? '';

      expect(response.status).toBe(200);
      expect(instructions).toContain('Primary harness instruction.');
      expect(instructions).toContain('Late harness instruction.');
      expect(instructions.indexOf('Primary harness instruction.'))
        .toBeLessThan(instructions.indexOf('Late harness instruction.'));
      expect(envelopeRequest?.contents?.map(message => ({
        role: message.role, text: message.parts?.map(part => part.text).join('\n'),
      }))).toEqual([
        { role: 'user', text: 'Earlier user turn.' },
        { role: 'model', text: 'Earlier assistant response.' },
        { role: 'user', text: 'Current user turn.' },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
    }
  });
});
