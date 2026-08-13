import { describe, it, expect, vi } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  createFakeSession,
  createPendingToolBridge,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
  registerPendingToolCall,
  toolResultPrompt,
} from './fixtures/copilot-connector-contract.js';

const CLAUDE_SESSION_ID = '44444444-4444-4444-8444-444444444444';

describe('createCopilotLanguageModel transcript classification', () => {
  it('extends the same session with a new-turn send on every classified new turn', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const session = createFakeSession();
    const classifyTranscript = vi.fn(() => ({ kind: 'new-turn' as const }));
    const { deps, runtime } = buildDeps({
      session,
      classifyTranscript,
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const options = callOptions({ claudeSessionId: CLAUDE_SESSION_ID });

    await collectStreamParts((await model.doStream(options)).stream);
    await collectStreamParts((await model.doStream(options)).stream);

    expect(runtime.createSession).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledTimes(2);
  });

  it('skips resending an exact-retry turn to the same session', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const session = createFakeSession();
    const classifyTranscript = vi.fn(() => ({ kind: 'exact-retry' as const }));
    const { deps, runtime } = buildDeps({
      session,
      classifyTranscript,
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const options = callOptions({ claudeSessionId: CLAUDE_SESSION_ID });

    await collectStreamParts((await model.doStream(options)).stream);
    await collectStreamParts((await model.doStream(options)).stream);

    expect(runtime.createSession).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledTimes(1);
  });

});

describe('createCopilotLanguageModel transcript resynchronization', () => {
  it('disconnects and recreates the session on an explicit resync', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const session = createFakeSession();
    const classifyTranscript = vi.fn(() => ({
      kind: 'resync' as const,
      reason: 'system-prompt-changed' as const,
    }));
    const { deps, runtime } = buildDeps({
      session,
      classifyTranscript,
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);
    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      prompt: [{ role: 'system', content: 'a new system prompt' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))).stream);

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(runtime.createSession).toHaveBeenCalledTimes(2);
    expect(session.send).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('"format":"leverframe-copilot-history-v1"'),
    }));
  });

});

describe('createCopilotLanguageModel tool-result continuation', () => {
  it('resolves a pending Copilot tool handler promise without resending the turn', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const session = createFakeSession();
    const toolBridge = createPendingToolBridge();
    const pending = registerPendingToolCall(toolBridge, 'call-1');
    const classifyTranscript = vi.fn(() => ({
      kind: 'tool-result-continuation' as const,
      resolvedToolCallIds: ['call-1'],
    }));
    const { deps, runtime } = buildDeps({
      session,
      toolBridge,
      classifyTranscript,
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);
    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      prompt: toolResultPrompt({ toolCallId: 'call-1', toolName: 'Read', input: '{"path":"a.ts"}', result: 'file contents' }),
    }))).stream);

    expect(toolBridge.resolveToolResults).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'Read',
        output: { type: 'text', value: 'file contents' },
      }),
    ]);
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe('file contents');
  });
});
