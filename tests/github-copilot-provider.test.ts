/** Because Copilot must not run local tools. */
import { describe, expect, it, vi } from 'vitest';
import { createCopilotHttpLanguageModel } from '../src/copilot/provider.js';

const token = globalThis.crypto.randomUUID();
const modelId = 'copilot-test-model';
const textResponse = {
  id: 'chat-test', object: 'chat.completion', created: 1, model: modelId,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
};
const responsesResponse = {
  id: 'response-test', object: 'response', created_at: 1, model: modelId, status: 'completed',
  output: [{ id: 'message-test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
  usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
};
const anthropicResponse = {
  id: 'message-test', type: 'message', role: 'assistant', model: modelId,
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 2 },
};

describe('Copilot native HTTP protocol selection', () => {
  it.each([
    { npm: '@ai-sdk/openai-compatible', path: '/chat/completions', response: textResponse },
    { npm: '@ai-sdk/openai', path: '/responses', response: responsesResponse },
    { npm: '@ai-sdk/anthropic', path: '/v1/messages', response: anthropicResponse },
  ])('uses $path with direct GitHub authentication', async ({ npm, path, response }) => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const model = await createCopilotHttpLanguageModel({ npm, modelId, githubToken: token, fetchImpl: network });
    const result = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK only.' }] }], maxOutputTokens: 8 });
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'OK' }));
    expect(network).toHaveBeenCalledTimes(1);
    const request = network.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`https://api.githubcopilot.com${path}`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(request.headers.has('x-api-key')).toBe(false);
    expect(await request.json()).toMatchObject({ model: modelId });
  });

  it('rejects unsupported adapters without importing a provider runtime', async () => {
    await expect(createCopilotHttpLanguageModel({ npm: 'unknown-runtime', modelId, githubToken: token })).rejects.toThrow(/protocol/i);
  });
});

describe('Copilot caller-owned tools', () => {
  it('sends tool definitions and returns tool calls without executing them', async () => {
    const reply = { ...textResponse, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'lookup', arguments: '{"key":"value"}' } }] }, finish_reason: 'tool_calls' }] };
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply));
    const model = await createCopilotHttpLanguageModel({ npm: '@ai-sdk/openai-compatible', modelId, githubToken: token, fetchImpl: network });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use lookup.' }] }],
      tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
      toolChoice: { type: 'tool', toolName: 'lookup' },
    });
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'lookup', toolCallId: 'call-one' }));
    const request = network.mock.calls[0]![0] as Request;
    expect(await request.json()).toMatchObject({ tools: [{ type: 'function', function: { name: 'lookup' } }], tool_choice: { type: 'function', function: { name: 'lookup' } } });
  });
});
