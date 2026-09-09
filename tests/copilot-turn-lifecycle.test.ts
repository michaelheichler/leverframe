import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createCopilotLanguageModel, type CopilotLanguageModelDependencies } from '../src/copilot/language-model.js';
import { createToolBridge } from '../src/copilot/tool-bridge.js';
import { classifyTranscript, deriveCopilotSessionKey } from '../src/copilot/transcript.js';
import { collectStreamParts, readableStreamFromParts } from './fixtures/copilot-connector-contract.js';

const finish: LanguageModelV3StreamPart = {
  type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } },
};
const options: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'first question' }] }],
  providerOptions: { copilot: { claudeSessionId: '11111111-1111-4111-8111-111111111111' } },
  tools: [{ type: 'function', name: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
};

function fixture() {
  const session = { sessionId: 'fake', send: vi.fn(async () => 'message'),
    on: vi.fn(() => () => {}), abort: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const bridge = createToolBridge(options.tools as Extract<NonNullable<typeof options.tools>[number], { type: 'function' }>[]);
  const runtime = { start: vi.fn(async () => {}), createSession: vi.fn(async () => session) };
  const deps: CopilotLanguageModelDependencies = {
    workingDirectory: '/tmp/leverframe-fake-copilot', getRuntime: async () => runtime,
    createToolBridge: () => bridge,
    bridgeSessionEvents: vi.fn(() => readableStreamFromParts([finish])),
    classifyTranscript, deriveSessionKey: deriveCopilotSessionKey,
  };
  const model = createCopilotLanguageModel({ modelId: 'fake-model' }, deps);
  return { model, deps, session, runtime, bridge };
}

async function drain(model: ReturnType<typeof fixture>['model'], input = options) {
  return collectStreamParts((await model.doStream(input)).stream);
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Copilot production tool and history state', () => {
  it('passes bridge parameter schemas and handlers into session creation', async () => {
    const f = fixture();
    await drain(f.model);
    expect(f.runtime.createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: f.bridge.copilotTools }), expect.any(Function));
    expect(f.bridge.copilotTools[0].parameters).toEqual({ type: 'object', properties: { path: { type: 'string' } } });
    expect(typeof f.bridge.copilotTools[0].handler).toBe('function');
    await f.model.dispose();
  });

  it('sends supplied history when the first session is cold', async () => {
    const f = fixture();
    await drain(f.model, { ...options, prompt: [...options.prompt,
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second question' }] }] });
    expect(f.session.send.mock.calls[0]).toEqual([expect.objectContaining({ prompt: expect.stringContaining('first question') })]);
    expect(f.session.send.mock.calls[0]).toEqual([expect.objectContaining({ prompt: expect.stringContaining('earlier answer') })]);
    await f.model.dispose();
  });

  it('resolves emitted tool calls without resending the user turn and replays the original request', async () => {
    const f = fixture();
    vi.mocked(f.deps.bridgeSessionEvents).mockReturnValueOnce(readableStreamFromParts([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: '{"path":"a"}' },
      { ...finish, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
    ]));
    const pending = f.bridge.copilotTools[0].handler({ path: 'a' }, { toolCallId: 'call-1', toolName: 'Read', sessionId: 'fake', arguments: { path: 'a' } });
    await drain(f.model);
    await drain(f.model);
    expect(f.session.send).toHaveBeenCalledTimes(1);
    const continuation: LanguageModelV3CallOptions = { ...options, prompt: [...options.prompt,
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: { path: 'a' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'Read', output: { type: 'text', value: 'contents' } }] }] };
    await drain(f.model, continuation);
    expect(f.session.send).toHaveBeenCalledTimes(1);
    expect(f.bridge.pendingToolCallIds()).toEqual([]);
    await expect(pending).resolves.toBe('contents');
    await f.model.dispose();
  });
});

describe('Copilot multi-step tools', () => {
  it('resolves only newly appended results across two tool continuations', async () => {
    const f = fixture();
    const toolPart = (id: string): LanguageModelV3StreamPart => ({
      type: 'tool-call', toolCallId: id, toolName: 'Read', input: '{"path":"a"}',
    });
    vi.mocked(f.deps.bridgeSessionEvents)
      .mockReturnValueOnce(readableStreamFromParts([toolPart('call-1'), finish]))
      .mockReturnValueOnce(readableStreamFromParts([toolPart('call-2'), finish]));
    const invoke = (id: string) => f.bridge.copilotTools[0].handler({ path: 'a' }, {
      toolCallId: id, toolName: 'Read', sessionId: 'fake', arguments: { path: 'a' },
    });
    const appendResult = (previous: LanguageModelV3CallOptions, id: string): LanguageModelV3CallOptions => ({
      ...previous, prompt: [...previous.prompt,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'Read', input: { path: 'a' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', output: { type: 'text', value: id } }] }],
    });
    const first = invoke('call-1');
    await drain(f.model);
    const second = invoke('call-2');
    const continuation = appendResult(options, 'call-1');
    await drain(f.model, continuation);
    await expect(first).resolves.toBe('call-1');
    await drain(f.model, appendResult(continuation, 'call-2'));
    await expect(second).resolves.toBe('call-2');
    expect(f.session.send).toHaveBeenCalledTimes(1);
    expect(f.bridge.pendingToolCallIds()).toEqual([]);
    await f.model.dispose();
  });
});

describe('Copilot startup ownership', () => {
  it('rejects overlap before asynchronous startup completes', async () => {
    const f = fixture();
    const gate = deferred();
    f.runtime.start.mockImplementation(() => gate.promise);
    const first = f.model.doStream(options);
    const second = f.model.doStream(options);
    const rejected = expect(second).rejects.toThrow('already active');
    gate.resolve();
    await rejected;
    await collectStreamParts((await first).stream);
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    await f.model.dispose();
  });

  it('disconnects a session created while disposal is waiting', async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    f.runtime.createSession.mockImplementation(async () => { entered.resolve(); await gate.promise; return f.session; });
    const first = f.model.doStream(options);
    const rejected = expect(first).rejects.toThrow('disposed');
    await entered.promise;
    const disposal = f.model.dispose();
    gate.resolve();
    await rejected;
    await disposal;
    expect(f.session.disconnect).toHaveBeenCalledTimes(1);
    expect(f.session.send).not.toHaveBeenCalled();
  });
});

describe('Copilot turn cancellation and replay', () => {
  it('aborts provider work and settles tools when the source reader rejects', async () => {
    const f = fixture();
    const error = new Error('source reader failed');
    const pending = f.bridge.copilotTools[0].handler({}, {
      toolCallId: 'pending', toolName: 'Read', sessionId: 'fake', arguments: {},
    });
    const settled = Promise.resolve(pending).catch(reason => reason);
    f.deps.bridgeSessionEvents = () => new ReadableStream({ start(controller) { controller.error(error); } });
    await expect(drain(f.model)).rejects.toBe(error);
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    expect(f.bridge.pendingToolCallIds()).toEqual([]);
    await settled;
    await f.model.dispose();
  });
  it('holds admission until upstream signal cancellation has completed', async () => {
    const f = fixture();
    const abort = new AbortController();
    const gate = deferred();
    f.session.abort.mockImplementation(() => gate.promise);
    f.deps.bridgeSessionEvents = () => new ReadableStream();
    const response = await f.model.doStream({ ...options, abortSignal: abort.signal });
    const rejected = expect(collectStreamParts(response.stream)).rejects.toThrow('aborted');
    abort.abort();
    await Promise.resolve();
    await Promise.resolve();
    await expect(f.model.doStream(options)).rejects.toThrow('already active');
    gate.resolve();
    await rejected;
    await f.model.dispose();
  });

  it('disposal terminates an active response and removes its signal listener', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.deps.bridgeSessionEvents = () => new ReadableStream();
    const response = await f.model.doStream({ ...options, abortSignal: abort.signal });
    const rejected = expect(collectStreamParts(response.stream)).rejects.toThrow('aborted');
    await f.model.dispose();
    await rejected;
    abort.abort();
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    expect(f.session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('releases admission after startup failure', async () => {
    const f = fixture();
    f.runtime.start.mockRejectedValueOnce(new Error('startup failed'));
    await expect(f.model.doStream(options)).rejects.toThrow('startup failed');
    await drain(f.model);
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    await f.model.dispose();
  });

  it('cleans up a send failure before accepting another turn', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.deps.bridgeSessionEvents = () => new ReadableStream();
    f.session.send.mockRejectedValueOnce(new Error('send failed'));
    await expect(f.model.doStream({ ...options, abortSignal: abort.signal })).rejects.toThrow('send failed');
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    const response = await f.model.doStream({ ...options, prompt: [...options.prompt,
      { role: 'user', content: [{ type: 'text', text: 'next' }] }] });
    abort.abort();
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    await response.stream.cancel();
    expect(f.session.abort).toHaveBeenCalledTimes(2);
    await f.model.dispose();
  });

  it('does not let an old signal abort a subsequent turn', async () => {
    const f = fixture();
    const abort = new AbortController();
    await drain(f.model, { ...options, abortSignal: abort.signal });
    f.deps.bridgeSessionEvents = () => new ReadableStream();
    const response = await f.model.doStream({ ...options, prompt: [...options.prompt,
      { role: 'user', content: [{ type: 'text', text: 'next' }] }] });
    abort.abort();
    expect(f.session.abort).not.toHaveBeenCalled();
    await response.stream.cancel();
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    await f.model.dispose();
  });

  it('consumer cancellation aborts upstream even without an abort signal', async () => {
    const f = fixture();
    f.deps.bridgeSessionEvents = () => new ReadableStream();
    const response = await f.model.doStream(options);
    await response.stream.cancel();
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    await f.model.dispose();
  });

  it.each([
    [{ type: 'error', error: new Error('429') }],
    [],
    [{ ...finish, finishReason: { unified: 'error', raw: 'error' } }],
  ] as LanguageModelV3StreamPart[][])('does not cache an unsuccessful stream %j', async (...parts) => {
    const f = fixture();
    f.deps.bridgeSessionEvents = () => readableStreamFromParts(parts);
    await drain(f.model);
    await drain(f.model);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    await f.model.dispose();
  });
});
