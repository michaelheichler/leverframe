import { describe, it, expect } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  createFakeSession,
  functionTool,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';

const CLAUDE_SESSION_ID = '22222222-2222-4222-8222-222222222222';

describe('createCopilotLanguageModel tool choice', () => {
  it('passes toolChoice "none" through to a session created with no available tools', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      tools: [functionTool('Read')],
      toolChoice: { type: 'none' },
    }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.availableTools).toEqual([]);
  });

  it('passes toolChoice "auto" through with every offered tool available', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      tools: [functionTool('Read'), functionTool('Write')],
      toolChoice: { type: 'auto' },
    }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.availableTools).toEqual(['Read', 'Write']);
  });
});

describe('createCopilotLanguageModel unsupported tool choice', () => {
  it('rejects toolChoice "required" before starting the runtime', async () => {
    const { createCopilotLanguageModel, CopilotUnsupportedToolChoiceError } = await loadCopilotLanguageModelModule();
    const { deps, getRuntimeSpy, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      tools: [functionTool('Read')],
      toolChoice: { type: 'required' },
    }))).rejects.toBeInstanceOf(CopilotUnsupportedToolChoiceError);

    expect(getRuntimeSpy).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it('rejects a named tool choice before creating a session', async () => {
    const { createCopilotLanguageModel, CopilotUnsupportedToolChoiceError } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      tools: [functionTool('Read')],
      toolChoice: { type: 'tool', toolName: 'Read' },
    }))).rejects.toBeInstanceOf(CopilotUnsupportedToolChoiceError);

    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it('rejects an unsupported tool choice for doGenerate too, before session creation', async () => {
    const { createCopilotLanguageModel, CopilotUnsupportedToolChoiceError } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doGenerate(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      toolChoice: { type: 'required' },
    }))).rejects.toBeInstanceOf(CopilotUnsupportedToolChoiceError);

    expect(runtime.createSession).not.toHaveBeenCalled();
  });

});

describe('createCopilotLanguageModel tool availability changes', () => {
  it('recreates the session when tool choice changes tool availability', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const prompt = callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      tools: [functionTool('Read')],
    }).prompt;

    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      prompt,
      tools: [functionTool('Read')],
      toolChoice: { type: 'none' },
    }))).stream);
    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      prompt,
      tools: [functionTool('Read')],
      toolChoice: { type: 'auto' },
    }))).stream);

    expect(runtime.createSession).toHaveBeenCalledTimes(2);
    expect(runtime.createSession.mock.calls[0]?.[0].availableTools).toEqual([]);
    expect(runtime.createSession.mock.calls[1]?.[0].availableTools).toEqual(['Read']);
  });
});

describe('createCopilotLanguageModel cancellation', () => {
  it('aborts the live Copilot session when the AI SDK abort signal fires mid-stream', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const session = createFakeSession();
    const { deps } = buildDeps({ session, bridgeSessionEvents: () => readableStreamFromParts([]) });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const controller = new AbortController();

    const result = await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      abortSignal: controller.signal,
    }));
    controller.abort();
    await collectStreamParts(result.stream);

    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it('never starts the runtime when the request arrives already aborted', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, getRuntimeSpy, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const controller = new AbortController();
    controller.abort();

    await expect(model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      abortSignal: controller.signal,
    }))).rejects.toThrow();

    expect(getRuntimeSpy).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
  });
});
