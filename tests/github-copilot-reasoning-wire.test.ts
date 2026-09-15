/** Because advertised effort must reach the HTTP request. */
import { expect, it, vi } from 'vitest';
import { parseCopilotModelInfo } from '../src/copilot/models.js';
import { createCopilotHttpLanguageModel } from '../src/copilot/provider.js';
import { generateAnthropicResponse, translateRequest } from '../src/sdk-adapter.js';

it('sends the selected effort for a chat-only Copilot model', async () => {
  const modelInfo = parseCopilotModelInfo({
    id: 'copilot-reasoning', name: 'Copilot reasoning',
    supported_endpoints: ['/chat/completions'],
    capabilities: { type: 'chat', supports: { reasoning_effort: true } },
    supported_reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high',
  });
  const npm = '@ai-sdk/openai-compatible';
  expect(modelInfo.npm).toBe(npm);
  const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'chat-test', object: 'chat.completion', created: 1, model: modelInfo.id,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
  const model = await createCopilotHttpLanguageModel({ npm, modelId: modelInfo.id, githubToken: globalThis.crypto.randomUUID(), fetchImpl: network });
  const params = translateRequest({
    model: modelInfo.id, messages: [{ role: 'user', content: 'test' }], output_config: { effort: 'high' }, max_tokens: 8,
  }, npm, { reasoningMetadata: { ...modelInfo, providerId: 'github-copilot' } });
  await generateAnthropicResponse(model, params, modelInfo.id);
  expect(network).toHaveBeenCalledTimes(1);
  const request = network.mock.calls[0]?.[0] as Request;
  expect(await request.json()).toMatchObject({ model: modelInfo.id, reasoning_effort: 'high' });
});
