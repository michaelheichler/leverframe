import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { createAntigravityLanguageModel } from '../src/antigravity/provider.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

useIsolatedTestHome('leverframe-antigravity-system-messages');
afterEach(() => vi.resetAllMocks());

function conversationMessages() {
  return [
    { role: 'user' as const, content: 'First user turn.' },
    { role: 'assistant' as const, content: 'Prior assistant response.' },
    { role: 'system' as const, content: 'Late harness instruction.' },
    { role: 'user' as const, content: 'Current user turn.' },
  ];
}

function captureRequest(requests: Array<Record<string, unknown>>) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Answer preserved.' }] }, finishReason: 'STOP' }],
    } });
  };
}

function requestParts(request: Record<string, unknown>) {
  const body = request['request'] as {
    systemInstruction?: { parts?: Array<{ text?: string }> };
    contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
  } | undefined;
  return {
    instructions: body?.systemInstruction?.parts?.map(part => part.text).join('\n') ?? '',
    contents: body?.contents?.map(message => ({ role: message.role, text: message.parts?.map(part => part.text).join('\n') })) ?? [],
  };
}

describe('Antigravity system-message normalization for generateText', () => {
  it('keeps instructions and prior conversation when a system message follows assistant content', async () => {
    resolveAntigravityAuth.mockResolvedValue({ accessToken: 'token-a', accountId: 'account-a', projectId: 'project-a' });
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(captureRequest(requests));
    const model = createAntigravityLanguageModel({ modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl });

    const result = await generateText({
      model,
      allowSystemInMessages: true,
      system: 'Initial harness instruction.',
      messages: conversationMessages(),
    });
    const outbound = requestParts(requests[0]!);

    expect(result.text).toBe('Answer preserved.');
    expect(outbound.instructions).toContain('Initial harness instruction.');
    expect(outbound.instructions).toContain('Late harness instruction.');
    expect(outbound.instructions.indexOf('Initial harness instruction.'))
      .toBeLessThan(outbound.instructions.indexOf('Late harness instruction.'));
    expect(outbound.contents).toEqual([
      { role: 'user', text: 'First user turn.' },
      { role: 'model', text: 'Prior assistant response.' },
      { role: 'user', text: 'Current user turn.' },
    ]);
  });
});

describe('Antigravity system-message normalization for streamText', () => {
  it('keeps instructions and prior conversation when a system message follows assistant content', async () => {
    resolveAntigravityAuth.mockResolvedValue({ accessToken: 'token-a', accountId: 'account-a', projectId: 'project-a' });
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Answer preserved."}]},"finishReason":"STOP"}]} }\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const model = createAntigravityLanguageModel({ modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl });

    const result = streamText({
      model,
      allowSystemInMessages: true,
      system: 'Initial harness instruction.',
      messages: conversationMessages(),
    });
    const text = await result.text;
    const outbound = requestParts(requests[0]!);

    expect(text).toBe('Answer preserved.');
    expect(outbound.instructions).toContain('Initial harness instruction.');
    expect(outbound.instructions).toContain('Late harness instruction.');
    expect(outbound.instructions.indexOf('Initial harness instruction.'))
      .toBeLessThan(outbound.instructions.indexOf('Late harness instruction.'));
    expect(outbound.contents).toEqual([
      { role: 'user', text: 'First user turn.' },
      { role: 'model', text: 'Prior assistant response.' },
      { role: 'user', text: 'Current user turn.' },
    ]);
  });
});
