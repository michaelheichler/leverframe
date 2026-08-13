import { describe, expect, it, vi } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  createFakeSession,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

const CLAUDE_SESSION_ID = '33333333-3333-4333-8333-333333333333';

const TEXT_AND_REASONING_PARTS: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'thinking it through' },
  { type: 'reasoning-end', id: 'r1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'hello ' },
  { type: 'text-delta', id: 't1', delta: 'world' },
  { type: 'text-end', id: 't1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: 2 },
    },
  },
];

const TOOL_CALL_PARTS: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id: 'call-1', toolName: 'Read' },
  { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"a.ts"}' },
  { type: 'tool-input-end', id: 'call-1' },
  { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: '{"path":"a.ts"}' },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 3, text: 0, reasoning: 0 },
    },
  },
];

describe('createCopilotLanguageModel doStream', () => {
  it('forwards streamed text and reasoning parts from the Copilot session unchanged', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps } = buildDeps({ bridgeSessionEvents: () => readableStreamFromParts(TEXT_AND_REASONING_PARTS) });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    const result = await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }));
    const parts = await collectStreamParts(result.stream);

    expect(parts).toEqual(TEXT_AND_REASONING_PARTS);
  });

  it('forwards streamed tool-call parts from the Copilot session unchanged', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps } = buildDeps({ bridgeSessionEvents: () => readableStreamFromParts(TOOL_CALL_PARTS) });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    const result = await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }));
    const parts = await collectStreamParts(result.stream);

    expect(parts).toEqual(TOOL_CALL_PARTS);
  });

  it('subscribes to session events before sending the user turn', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    let subscribedDuringSend = false;
    const session = createFakeSession();
    session.send = vi.fn(async () => {
      subscribedDuringSend = session.handlers.length > 0;
      return 'message-1';
    });
    const { deps } = buildDeps({
      session,
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await model.doStream(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }));

    expect(subscribedDuringSend).toBe(true);
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('hello'),
    }));
  });
});

describe('createCopilotLanguageModel doGenerate', () => {
  it('collects streamed text into a single generate result, matching the AI SDK V3 contract', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps } = buildDeps({ bridgeSessionEvents: () => readableStreamFromParts(TEXT_AND_REASONING_PARTS) });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    const result = await model.doGenerate(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }));

    expect(result.content).toContainEqual({ type: 'text', text: 'hello world' });
    expect(result.content).toContainEqual({ type: 'reasoning', text: 'thinking it through' });
    expect(result.finishReason.unified).toBe('stop');
    expect(result.usage.outputTokens.total).toBe(5);
  });

  it('collects a streamed tool call into the generate result content', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps } = buildDeps({ bridgeSessionEvents: () => readableStreamFromParts(TOOL_CALL_PARTS) });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    const result = await model.doGenerate(callOptions({ claudeSessionId: CLAUDE_SESSION_ID }));

    expect(result.content).toContainEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'Read',
      input: '{"path":"a.ts"}',
    });
    expect(result.finishReason.unified).toBe('tool-calls');
  });

  it('reports specificationVersion v3 and the github-copilot provider id', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('github-copilot');
    expect(model.modelId).toBe('claude-sonnet-4-6');
  });
});
