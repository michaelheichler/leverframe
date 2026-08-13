import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';

const SESSION_ID = '66666666-6666-4666-8666-666666666666';
const RESPONSE: LanguageModelV3StreamPart[] = [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'cached response' },
  { type: 'text-end', id: 'text-1' },
  {
    type: 'finish',
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    finishReason: { unified: 'stop', raw: 'stop' },
  },
];

describe('createCopilotLanguageModel exact retry', () => {
  it('replays the completed response without a second session subscription or send', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const bridgeSessionEvents = vi.fn(() => readableStreamFromParts(RESPONSE));
    const { deps, session } = buildDeps({
      bridgeSessionEvents,
      classifyTranscript: vi.fn(() => ({ kind: 'exact-retry' as const })),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const options = callOptions({ claudeSessionId: SESSION_ID });

    const first = await collectStreamParts((await model.doStream(options)).stream);
    const retry = await collectStreamParts((await model.doStream(options)).stream);

    expect(retry).toEqual(first);
    expect(bridgeSessionEvents).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledTimes(1);
  });
});
