import { describe, expect, it, vi } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  createFakeSession,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';

const SESSION_A = '77777777-7777-4777-8777-777777777777';
const SESSION_B = '88888888-8888-4888-8888-888888888888';

function isolatedRuntime() {
  const sessionA = createFakeSession({ sessionId: 'copilot-a' });
  const sessionB = createFakeSession({ sessionId: 'copilot-b' });
  const runtime = {
    start: vi.fn(async () => undefined),
    createSession: vi.fn()
      .mockResolvedValueOnce(sessionA)
      .mockResolvedValueOnce(sessionB),
  };
  return { sessionA, sessionB, runtime };
}

describe('createCopilotLanguageModel Claude session isolation', () => {
  it('keeps two Claude sessions live and routes later turns to their own Copilot sessions', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { sessionA, sessionB, runtime } = isolatedRuntime();
    const { deps } = buildDeps({
      runtime,
      bridgeSessionEvents: () => readableStreamFromParts([]),
      classifyTranscript: vi.fn(() => ({ kind: 'new-turn' as const })),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_A }))).stream);
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_B }))).stream);
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_A }))).stream);

    expect(runtime.createSession).toHaveBeenCalledTimes(2);
    expect(sessionA.send).toHaveBeenCalledTimes(2);
    expect(sessionB.send).toHaveBeenCalledTimes(1);
    expect(sessionA.disconnect).not.toHaveBeenCalled();
    expect(sessionB.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects every isolated session during disposal', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { sessionA, sessionB, runtime } = isolatedRuntime();
    const { deps } = buildDeps({
      runtime,
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_A }))).stream);
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_B }))).stream);

    await model.dispose();

    expect(sessionA.disconnect).toHaveBeenCalledTimes(1);
    expect(sessionB.disconnect).toHaveBeenCalledTimes(1);
  });
});
