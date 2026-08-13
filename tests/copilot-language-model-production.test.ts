import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultCopilotLanguageModel } from '../src/copilot/language-model-default.js';
import type { CopilotRuntimeHandle } from '../src/copilot/runtime.js';

const runtime = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('../src/copilot/runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/copilot/runtime.js')>();
  return { ...actual, createDefaultCopilotRuntime: runtime.create };
});

const SESSION_ID = '99999999-9999-4999-8999-999999999999';

function runtimeHandle(): CopilotRuntimeHandle {
  const onHandlers: Array<(event: unknown) => void> = [];
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(async config => {
      const onEvent = (config as { onEvent?: (event: unknown) => void }).onEvent;
      if (onEvent !== undefined) onHandlers.push(onEvent);
      return {
        sessionId: 'copilot-session-1',
        on: vi.fn((handler: (event: unknown) => void) => {
          onHandlers.push(handler);
          return () => undefined;
        }),
        send: vi.fn(async () => {
          const events = [
            { type: 'assistant.message_start', id: 'evt-1', timestamp: '2026-01-01T00:00:00Z', parentId: null, data: { messageId: 'msg-1' } },
            { type: 'assistant.message_delta', id: 'evt-2', timestamp: '2026-01-01T00:00:01Z', parentId: 'evt-1', data: { messageId: 'msg-1', deltaContent: 'hello' } },
            { type: 'assistant.message', id: 'evt-3', timestamp: '2026-01-01T00:00:02Z', parentId: 'evt-2', data: { messageId: 'msg-1', content: 'hello' } },
            { type: 'assistant.usage', id: 'evt-4', timestamp: '2026-01-01T00:00:03Z', parentId: 'evt-3', data: { model: 'fixture', inputTokens: 2, outputTokens: 1, finishReason: 'stop' } },
            { type: 'assistant.turn_end', id: 'evt-5', timestamp: '2026-01-01T00:00:04Z', parentId: 'evt-4', data: { turnId: 'turn-1' } },
          ];
          for (const event of events) for (const handler of onHandlers) handler(event);
          return 'msg-1';
        }),
        abort: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
      };
    }),
  };
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe('createDefaultCopilotLanguageModel', () => {
  it('streams events through the real production dependency wiring without starting GitHub', async () => {
    const handle = runtimeHandle();
    runtime.create.mockReturnValue(handle);
    const model = createDefaultCopilotLanguageModel({
      modelId: 'claude-sonnet-4-6',
      gitHubToken: ['fixture', 'credential'].join('-'),
      environment: { LEVERFRAME_HOME: '/fixture/leverframe' },
      nodeVersion: '22.12.0',
    });

    const result = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: { copilot: { claudeSessionId: SESSION_ID } },
    });
    const parts = await collect(result.stream);

    expect(parts.map(part => part.type)).toEqual([
      'text-start', 'text-delta', 'text-end', 'finish',
    ]);
    expect(handle.createSession).toHaveBeenCalledTimes(1);
    const config = vi.mocked(handle.createSession).mock.calls[0]?.[0] as {
      createSessionFsProvider?: () => {
        exists(path: string): Promise<boolean>;
        writeFile(path: string, content: string): Promise<void>;
        mkdir(path: string, recursive: boolean): Promise<void>;
      };
    };
    const sessionFs = config.createSessionFsProvider?.();
    expect(sessionFs).toBeDefined();
    await sessionFs?.mkdir('/session', true);
    await sessionFs?.writeFile('/session/private.json', 'prompt body');
    expect(await sessionFs?.exists('/session/private.json')).toBe(true);
  });
});
