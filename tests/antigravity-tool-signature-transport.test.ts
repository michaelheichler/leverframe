import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, jsonSchema, tool } from 'ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

import { createAntigravityLanguageModel } from '../src/antigravity/provider.js';

afterEach(() => vi.resetAllMocks());

async function signedToolContinuation(input: {
  fetchImpl: typeof fetch;
}): Promise<{ toolCallId: string }> {
  const availableTools = { inspect: tool({
    inputSchema: jsonSchema({ type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }),
  }) };
  const model = createAntigravityLanguageModel({
    modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl: input.fetchImpl,
  });
  const firstTurn = await generateText({
    model,
    tools: availableTools,
    prompt: 'Call inspect with target example',
    headers: { 'x-leverframe-antigravity-session': 'session-one' },
  });
  const call = firstTurn.toolCalls[0]!;
  const continuationModel = createAntigravityLanguageModel({
    modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a',
    fetchImpl: input.fetchImpl,
  });
  await generateText({
    model: continuationModel,
    tools: availableTools,
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'json', value: { accepted: true } } }] },
    ],
    headers: { 'x-leverframe-antigravity-session': 'session-one' },
  });
  return { toolCallId: call.toolCallId };
}

describe('Antigravity signed tool continuation', () => {
  it('keeps a large signed tool call resumable through the Google SDK across turns', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-tool-signatures-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
    resolveAntigravityAuth.mockResolvedValue({
      accessToken: 'account-a-access', accountId: 'account-a', projectId: 'project-a',
    });
    const signature = 's'.repeat(4096);
    const requests: Array<Record<string, unknown>> = [];
    const capture = (body: unknown) => async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(body);
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(capture({ response: {
        candidates: [{ content: { role: 'model', parts: [{ functionCall: {
          id: 'upstream-tool-call', name: 'inspect', args: { target: 'example' },
        }, thoughtSignature: signature }] }, finishReason: 'STOP' }],
      } }))
      .mockImplementationOnce(capture({ response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'continued' }] }, finishReason: 'STOP' }],
      } }));
    const result = await signedToolContinuation({ fetchImpl });

    expect(result.toolCallId.length).toBeLessThan(256);
    const contents = requests[1]?.['request'] as { contents?: Array<{ parts?: Array<Record<string, unknown>> }> } | undefined;
    expect(contents?.contents?.flatMap(item => item.parts ?? [])).toContainEqual(expect.objectContaining({
      functionCall: expect.objectContaining({ id: 'upstream-tool-call' }),
      thoughtSignature: signature,
    }));
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
