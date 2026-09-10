import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { recordCopilotResponse } from '../src/copilot/response-replay.js';

const finish: LanguageModelV3StreamPart = {
  type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } },
};

describe('Copilot replay terminal admission', () => {
  it('does not publish a buffered finish when cancellation ends a pending read', async () => {
    const onComplete = vi.fn();
    const onSettled = vi.fn();
    const cancel = vi.fn();
    let signalPending = () => {};
    const pendingStarted = new Promise<void>(resolve => { signalPending = resolve; });
    const stream = recordCopilotResponse({ stream: new ReadableStream({
      start(controller) { controller.enqueue(finish); },
      pull() { signalPending(); return new Promise<void>(() => {}); },
      cancel,
    }, { highWaterMark: 0 }), onComplete, onSettled });
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(finish);
    const pendingRead = reader.read();
    await pendingStarted;
    await reader.cancel('consumer stopped');
    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledWith('consumer stopped');
    expect(onComplete).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles once when the provider throws', async () => {
    const onComplete = vi.fn();
    const onSettled = vi.fn();
    const stream = recordCopilotResponse({ stream: new ReadableStream({
      pull(controller) { controller.error(new Error('provider failed')); },
    }), onComplete, onSettled });
    await expect(stream.getReader().read()).rejects.toThrow('provider failed');
    expect(onComplete).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
