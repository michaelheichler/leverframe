import { describe, it, expect } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  functionTool,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';

const CLAUDE_SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('createCopilotLanguageModel session bootstrap', () => {
  it('starts the runtime and creates a session on the first call', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime, getRuntimeSpy } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    expect(getRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it('reuses the same session across a second call with an identical session key', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    expect(runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it('creates the session in isolated empty mode with the system message in replace mode', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      prompt: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.systemMessage).toEqual({ mode: 'replace', content: 'You are a coding assistant.' });
  });

  it('sets availableTools to exactly the custom tool names', async () => {
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

  it('sets availableTools to an empty list when no tools are supplied', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.availableTools).toEqual([]);
  });

  it('disables memory, infinite sessions, session store, config discovery, skills, custom instructions and remote-only agents', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.memory).toEqual({ enabled: false });
    expect(config.infiniteSessions).toEqual({ enabled: false });
    expect(config.enableSessionStore).toBe(false);
    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.enableSkills).toBe(false);
    expect(config.skipCustomInstructions).toBe(true);
    expect(config.customAgentsLocalOnly).toBe(true);
    expect(config.toolSearch).toEqual({ enabled: false });
  });

  it('never wires plugins, MCP servers, or custom subagents into the session config', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.pluginDirectories).toBeUndefined();
    expect(config.mcpServers).toBeUndefined();
    expect(config.customAgents).toBeUndefined();
  });

  it('never grants repository access: no cloud repository config, working directory is the isolated app directory', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.cloud).toBeUndefined();
    expect(typeof config.workingDirectory).toBe('string');
    expect(config.workingDirectory).not.toBe(process.cwd());
  });

  it('never wires the built-in permission approval route: onPermissionRequest is omitted', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, runtime } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);

    const config = runtime.createSession.mock.calls[0][0];
    expect(config.onPermissionRequest).toBeUndefined();
  });

  it('derives the session key from the Claude session id, model, reasoning effort and prompt/tool hashes', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, deriveSessionKey } = (() => {
      const built = buildDeps();
      const spy = built.deps.deriveSessionKey;
      return { deps: built.deps, deriveSessionKey: spy };
    })();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: CLAUDE_SESSION_ID,
      reasoningEffort: 'high',
      tools: [functionTool('Read')],
    }))).stream);

    expect(deriveSessionKey).toHaveBeenCalledWith(expect.objectContaining({
      claudeSessionId: CLAUDE_SESSION_ID,
      upstreamModel: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
    }));
  });

  it('rejects when the request carries no validated Claude session id', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: '',
      providerOptions: {},
    }))).rejects.toThrow();
  });

  it('supports explicit disposal that disconnects the underlying Copilot session', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, session, toolBridge } = buildDeps({
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }))).stream);
    await model.dispose();

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(toolBridge.settleAllPending).toHaveBeenCalledWith('disposal');
  });
});
