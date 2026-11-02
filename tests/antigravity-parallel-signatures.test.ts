import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText, jsonSchema, tool } from 'ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

import { createAntigravityLanguageModel } from '../src/antigravity/provider.js';

afterEach(() => vi.resetAllMocks());

async function continueParallelToolCalls(input: {
  fetchImpl: typeof fetch;
}): Promise<void> {
  const inputSchema = jsonSchema({ type: 'object', properties: { target: { type: 'string' } }, required: ['target'] });
  const tools = { inspect: tool({ inputSchema }), search: tool({ inputSchema }) };
  const firstTurn = await generateText({
    model: createAntigravityLanguageModel({
      modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl: input.fetchImpl,
    }),
    tools,
    prompt: 'Inspect and search for example.',
    headers: { 'x-leverframe-antigravity-session': 'session-parallel' },
  });
  vi.resetModules();
  const restartedProvider = await import('../src/antigravity/provider.js');

  await generateText({
    model: restartedProvider.createAntigravityLanguageModel({
      modelId: 'gemini-3.1-pro-high', expectedAccountId: 'account-a', fetchImpl: input.fetchImpl,
    }),
    tools,
    messages: [
      { role: 'assistant', content: firstTurn.toolCalls.map(call => ({
        type: 'tool-call' as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input,
      })) },
      { role: 'tool', content: firstTurn.toolCalls.map(call => ({
        type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: call.toolName,
        output: { type: 'json' as const, value: { accepted: true } },
      })) },
    ],
    headers: { 'x-leverframe-antigravity-session': 'session-parallel' },
  });
}

describe('Antigravity parallel tool signatures', () => {
  it('resumes parallel calls after restart without inventing a signature for the unsigned peer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-parallel-signatures-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      resolveAntigravityAuth.mockResolvedValue({
        accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a',
      });
      const signature = 'p'.repeat(4096);
      const outboundRequests: Array<Record<string, unknown>> = [];
      const replies = [
        { response: { candidates: [{ content: { role: 'model', parts: [
          { functionCall: { id: 'signed-upstream-id', name: 'inspect', args: { target: 'example' } }, thoughtSignature: signature },
          { functionCall: { id: 'unsigned-upstream-id', name: 'search', args: { target: 'example' } } },
        ] }, finishReason: 'STOP' }] } },
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Both tools completed.' }] }, finishReason: 'STOP' }] } },
      ];
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async (_input, init) => {
        outboundRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(replies[0]);
      }).mockImplementationOnce(async (_input, init) => {
        outboundRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(replies[1]);
      });

      await continueParallelToolCalls({ fetchImpl });

      const request = outboundRequests[1]?.['request'] as {
        contents?: Array<{ parts?: Array<Record<string, unknown>> }>;
      } | undefined;
      const calls = request?.contents?.flatMap(message => message.parts ?? [])
        .filter(part => typeof part.functionCall === 'object') ?? [];

      expect(calls).toHaveLength(2);
      expect(calls).toContainEqual(expect.objectContaining({
        functionCall: expect.objectContaining({ id: 'signed-upstream-id' }), thoughtSignature: signature,
      }));
      expect(calls).toContainEqual(expect.objectContaining({
        functionCall: expect.objectContaining({ id: 'unsigned-upstream-id' }),
      }));
      expect(calls).not.toContainEqual(expect.objectContaining({
        functionCall: expect.objectContaining({ id: 'unsigned-upstream-id' }), thoughtSignature: expect.any(String),
      }));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
