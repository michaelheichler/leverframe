import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  createFakeSession,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINISH: LanguageModelV3StreamPart = {
  type: 'finish',
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  finishReason: { unified: 'stop', raw: 'stop' },
};

describe('createCopilotLanguageModel overlapping requests', () => {
  it('rejects a second request for the same Claude session while the first response is active', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const session = createFakeSession();
    const { deps } = buildDeps({
      session,
      bridgeSessionEvents: vi.fn()
        .mockReturnValueOnce(new ReadableStream())
        .mockReturnValueOnce(readableStreamFromParts([FINISH])),
      classifyTranscript: vi.fn(() => ({ kind: 'new-turn' as const })),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const first = await model.doStream(callOptions({ claudeSessionId: SESSION_ID }));

    await expect(model.doStream(callOptions({
      claudeSessionId: SESSION_ID,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }],
    }))).rejects.toThrow(/active|progress/i);

    await first.stream.cancel();
  });

  it('accepts a later request after the first response closes', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, session } = buildDeps({
      bridgeSessionEvents: () => readableStreamFromParts([FINISH]),
      classifyTranscript: vi.fn(() => ({ kind: 'new-turn' as const })),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_ID }))).stream);
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_ID }))).stream);

    expect(session.send).toHaveBeenCalledTimes(2);
  });

  it('does not collide when two concurrent calls under one Claude session have distinct call identities', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const sessionA = createFakeSession({ sessionId: 'copilot-a' });
    const sessionB = createFakeSession({ sessionId: 'copilot-b' });
    const runtime = {
      start: vi.fn(async () => undefined),
      createSession: vi.fn()
        .mockResolvedValueOnce(sessionA)
        .mockResolvedValueOnce(sessionB),
    };
    const { deps } = buildDeps({
      runtime,
      bridgeSessionEvents: vi.fn()
        .mockReturnValueOnce(new ReadableStream())
        .mockReturnValueOnce(readableStreamFromParts([FINISH])),
      classifyTranscript: vi.fn(() => ({ kind: 'new-turn' as const })),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    const first = await model.doStream(callOptions({ claudeSessionId: SESSION_ID, reasoningEffort: 'low' }));
    const second = await model.doStream(callOptions({ claudeSessionId: SESSION_ID, reasoningEffort: 'high' }));
    await collectStreamParts(second.stream);

    expect(runtime.createSession).toHaveBeenCalledTimes(2);
    expect(sessionA.send).toHaveBeenCalledTimes(1);
    expect(sessionB.send).toHaveBeenCalledTimes(1);

    await first.stream.cancel();
  });
});
