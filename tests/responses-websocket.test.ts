import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

// Fake `ws` WebSocket that records constructor args and lets tests drive events.
const { fakeSockets } = vi.hoisted(() => ({ fakeSockets: [] as FakeWebSocket[] }));

class FakeWebSocket extends EventEmitter {
  url: string;
  options: { headers?: Record<string, string> };
  send = vi.fn();
  close = vi.fn();
  constructor(url: string, options: { headers?: Record<string, string> }) {
    super();
    this.url = url;
    this.options = options;
    fakeSockets.push(this);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));

import {
  createResponsesWebSocketFetch as createResponsesWebSocketFetchImpl,
  resetResponsesWebSocketConnectionsForTests,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFingerprint,
  withResponsesWebSocketDiagnosticContext,
  type ResponsesWebSocketDiagnosticEvent,
  type ResponsesWebSocketFetchOptions,
} from '../src/oauth/responses-websocket.js';

function createResponsesWebSocketFetch(
  wsUrl: string,
  log?: (message: string) => void,
  options: ResponsesWebSocketFetchOptions = {},
) {
  return createResponsesWebSocketFetchImpl(wsUrl, log, {
    maxTransportRetries: 0,
    ...options,
    eagerResponseForTests: true,
  });
}

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function lastSocket(): FakeWebSocket {
  return fakeSockets[fakeSockets.length - 1]!;
}

const sessionPayload = (input: unknown[], extra: Record<string, unknown> = {}) => ({
  model: 'gpt-5.6-sol',
  prompt_cache_key: 'relay-session-abc',
  instructions: 'You are a coding assistant.',
  tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
  reasoning: { effort: 'high' },
  store: false,
  input,
  ...extra,
});

function emitTextResponse(socket: FakeWebSocket, responseId: string, text: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.created', response: { id: responseId },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_text.delta', item_id: `msg_${responseId}`, delta: text,
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done', output_index: 0,
    item: { type: 'message', id: `msg_${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.completed', response: { id: responseId },
  })));
}

describe('createResponsesWebSocketFetch', () => {
  beforeEach(() => {
    resetResponsesWebSocketConnectionsForTests();
    fakeSockets.length = 0;
  });

  it('forwards request headers and adds the WebSocket beta header on the upgrade', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok',
        'ChatGPT-Account-Id': 'acct-123',
        originator: 'leverframe',
        version: '0.144.1',
        'x-openai-internal-codex-responses-lite': 'true',
      },
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: [] }),
    });

    const headers = lastSocket().options.headers ?? {};
    expect(lastSocket().url).toBe(WS_URL);
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-123');
    expect(headers['version']).toBe('0.144.1');
    expect(headers['x-openai-internal-codex-responses-lite']).toBe('true');
    expect(headers['OpenAI-Beta']).toContain('responses_websockets');
  });

  it('sends the payload as the first frame and folds in the Responses-Lite shape', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: { effort: 'high' } }),
    });

    const socket = lastSocket();
    socket.emit('open');
    expect(socket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    // Must be a `response.create` event with the Responses fields at top level.
    expect(sent.type).toBe('response.create');
    expect(sent.model).toBe('gpt-5.6-luna');
    expect(sent.parallel_tool_calls).toBe(false);
    expect(sent.store).toBe(false);
    expect(sent.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
  });

  it('does not mutate the body when the Responses-Lite header is absent', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
    });
    const socket = lastSocket();
    socket.emit('open');
    const sent = JSON.parse(socket.send.mock.calls[0]![0] as string);
    // Still wrapped in the response.create envelope, but no Responses-Lite fields added.
    expect(sent).toEqual({ type: 'response.create', model: 'gpt-5.6-sol' });
  });

  it('collapses each frame onto a single SSE data line and closes on response.completed', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    const socket = lastSocket();
    socket.emit('open');
    // Pretty-printed JSON frame must not become a multi-line SSE event.
    socket.emit('message', Buffer.from('{\n  "type": "response.output_text.delta",\n  "delta": "hi"\n}'));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed' })));

    const body = await readAll(res);
    const lines = body.split('\n\n').filter(Boolean);
    expect(lines[0]).toBe('data: {"type":"response.output_text.delta","delta":"hi"}');
    expect(lines[1]).toBe('data: {"type":"response.completed"}');
    expect(socket.close).toHaveBeenCalled();
  });

  it('logs privacy-safe raw cache usage from the terminal response event', async () => {
    const debug: string[] = [];
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, message => debug.push(message), {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      {
        requestId: 'req-usage',
        claudeSessionId: '927b8642-15d2-4535-ab27-1430ae54c4aa',
      },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_usage',
        usage: {
          input_tokens: 1_200,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 },
          output_tokens: 50,
        },
      },
    })));
    await readAll(res);

    expect(debug).toContain(
      'ws: usage input_tokens=1200 cached_tokens=900 cache_write_tokens=200 output_tokens=50',
    );
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_usage',
      requestId: 'req-usage',
      claudeSessionId: '927b8642-15d2-4535-ab27-1430ae54c4aa',
      connectionId: 1,
      generation: 'isolated',
      continued: false,
      retried: false,
      inputTokens: 1_200,
      cachedTokens: 900,
      cacheWriteTokens: 200,
      outputTokens: 50,
    }));
  });

  it('surfaces a typed socket error and logs privacy-safe diagnostics', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-socket-error' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    const error = Object.assign(new Error('secret socket failure'), { code: 'ECONNRESET' });
    socket.emit('error', error);
    await expect(readAll(res)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      phase: 'connect',
      retryable: true,
      outputEmitted: false,
      attemptCount: 1,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-socket-error',
      connectionId: 1,
      generation: 'isolated',
      source: 'socket_error',
      socketErrorName: 'Error',
      socketErrorCode: 'ECONNRESET',
      failurePhase: 'connect',
      retryable: true,
      emittedModelData: false,
      attemptCount: 1,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('secret socket failure');
  });

  it('retries one transient pre-frame failure on a fresh socket', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      maxTransportRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
      onDiagnostic: event => diagnostics.push(event),
    });
    const payload = sessionPayload([{
      role: 'user',
      content: [{ type: 'input_text', text: 'retry this request' }],
    }]);
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload),
    });
    const first = lastSocket();
    first.emit('error', Object.assign(new Error('private reset'), { code: 'ECONNRESET' }));

    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2));
    const replacement = lastSocket();
    replacement.emit('open');
    expect(JSON.parse(replacement.send.mock.calls[0]?.[0] as string)).toEqual({
      type: 'response.create',
      ...payload,
    });
    emitTextResponse(replacement, 'resp_transport_retry', 'recovered');

    expect(await readAll(res)).toContain('recovered');
    expect(first.close).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      attemptNumber: 2,
      source: 'socket_error',
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'recovered',
      attemptNumber: 2,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private reset');
  });

  it.each([
    ['a headerless response', {}, 5_000],
    ['an oversized retry-after header', { 'retry-after': '3600' }, 60_000],
  ])('normalizes a bodyless 403 upgrade throttle with %s to HTTP 429', async (_label, headers, expectedRetryAfterMs) => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      maxTransportRetries: 0,
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 403,
      headers,
      resume: vi.fn(),
      destroy: vi.fn(),
    });

    lastSocket().emit('unexpected-response', {}, response);

    await expect(readAll(res)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      httpStatus: 429,
      retryAfterMs: expectedRetryAfterMs,
      retryable: true,
      attemptCount: 1,
    });
    expect(response.resume).toHaveBeenCalledOnce();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'unexpected_response',
      httpStatusCode: 403,
      mappedStatusCode: 429,
      retryAfterMs: expectedRetryAfterMs,
    }));
  });

  it('retries an in-band WebSocket connection-limit error before any output (upstream 32c1f7b)', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      maxTransportRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ])),
    });
    const first = lastSocket();
    first.emit('open');
    // The connection-limit rejection arrives as the very first in-band frame
    // — no model output has been produced yet, so it must still be eligible
    // for the pre-output transport retry even though frameCount is no
    // longer 0.
    first.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'websocket_connection_limit_reached', message: 'limit reached', retry_after_seconds: 0 },
    })));

    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2));
    const replacement = lastSocket();
    replacement.emit('open');
    emitTextResponse(replacement, 'resp_connection_limit_retry', 'recovered');

    expect(await readAll(res)).toContain('recovered');
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_transport_retry',
      outcome: 'started',
      attemptNumber: 2,
      source: 'error_frame',
      errorCode: 'websocket_connection_limit_reached',
      mappedStatusCode: 429,
    }));
  });

  it('does not retry an in-band connection-limit error once output has already been emitted', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      maxTransportRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      delta: 'partial',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      error: { code: 'websocket_connection_limit_reached', message: 'limit reached' },
    })));

    expect(fakeSockets).toHaveLength(1);
    await expect(readAll(res)).resolves.not.toContain('recovered');
  });

  it('stops after exactly one pre-frame transport retry', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      maxTransportRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    lastSocket().emit('error', Object.assign(new Error('first reset'), { code: 'ECONNRESET' }));
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2));
    lastSocket().emit('error', Object.assign(new Error('second reset'), { code: 'ECONNRESET' }));

    await expect(readAll(res)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      retryable: true,
      attemptCount: 2,
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(fakeSockets).toHaveLength(2);
  });

  it.each([
    ['partial output', {
      type: 'response.output_text.delta',
      item_id: 'msg_partial',
      delta: 'partial',
    }],
    ['tool call', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'call_1', name: 'Write', arguments: '{}' },
    }],
  ])('does not retry after a %s frame', async (_label, frame) => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      maxTransportRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
    });
    const res = await wsFetch('https://x', {
      method: 'POST',
      headers: {},
      body: JSON.stringify(sessionPayload([])),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify(frame)));
    socket.emit('error', Object.assign(new Error('post-output reset'), { code: 'ECONNRESET' }));

    await expect(readAll(res)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      outputEmitted: true,
      attemptCount: 1,
    });
    expect(fakeSockets).toHaveLength(1);
  });

  it('cancels a scheduled retry during backoff', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        maxTransportRetries: 1,
        retryBaseDelayMs: 10_000,
        retryMaxDelayMs: 10_000,
        random: () => 0,
      });
      const res = await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([])),
        signal: controller.signal,
      });
      lastSocket().emit('error', Object.assign(new Error('reset before abort'), { code: 'ECONNRESET' }));
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      await vi.runAllTimersAsync();

      expect(await readAll(res)).toBe('');
      expect(fakeSockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled retry during transport shutdown', async () => {
    vi.useFakeTimers();
    try {
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        maxTransportRetries: 1,
        retryBaseDelayMs: 10_000,
        retryMaxDelayMs: 10_000,
        random: () => 0,
      });
      const res = await wsFetch('https://x', {
        method: 'POST',
        headers: {},
        body: JSON.stringify(sessionPayload([])),
      });
      lastSocket().emit('error', Object.assign(new Error('reset before shutdown'), { code: 'ECONNRESET' }));
      resetResponsesWebSocketConnectionsForTests();
      await vi.runAllTimersAsync();

      expect(await readAll(res)).toBe('');
      expect(fakeSockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs sanitized upstream response failure details after partial output', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-response-failed' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: '{}' }),
    );
    const socket = lastSocket();
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'partial',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'resp_failed',
        status: 'failed',
        error: {
          type: 'server_error',
          code: 'internal_error',
          message: 'sensitive backend explanation',
        },
      },
    })));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_error',
      requestId: 'req-response-failed',
      connectionId: 1,
      source: 'response_event',
      upstreamEventType: 'response.failed',
      errorType: 'server_error',
      errorCode: 'internal_error',
      responseStatus: 'failed',
      emittedModelData: true,
      willRetry: false,
      errorMessageBytes: 29,
      errorMessageHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive backend explanation');
  });

  it('logs a content-free anomaly when reasoning delta has no matching start', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-reasoning-anomaly' },
      () => wsFetch('https://x', { method: 'POST', headers: {}, body: JSON.stringify({ store: false }) }),
    );
    const socket = lastSocket();
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'sensitive-reasoning-item-id',
      summary_index: 0,
      delta: 'sensitive reasoning text',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_anomaly' },
    })));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_protocol_anomaly',
      requestId: 'req-reasoning-anomaly',
      connectionId: 1,
      source: 'response_event_sequence',
      anomaly: 'reasoning_start_missing_before_delta',
      upstreamEventType: 'response.reasoning_summary_text.delta',
      itemIdHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      summaryIndex: 0,
      knownSummaryParts: [],
      recentUpstreamEventTypes: ['response.reasoning_summary_text.delta'],
      emittedModelData: false,
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive-reasoning-item-id');
    expect(JSON.stringify(diagnostics)).not.toContain('sensitive reasoning text');
  });

  it('accepts a correctly sequenced multi-part reasoning response', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify({ store: false }),
    });
    const socket = lastSocket();
    const events = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1',
        summary_index: 0, delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'reasoning-1', summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1',
        summary_index: 1, delta: 'second',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-1', summary_index: 1,
      },
      {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1' },
      },
      { type: 'response.completed', response: { id: 'resp_reasoning' } },
    ];
    for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
    await readAll(res);

    expect(diagnostics.some(event => event.event === 'ws_response_protocol_anomaly')).toBe(false);
  });

  it('detects a late delta for a reasoning part the SDK has already concluded', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      onDiagnostic: event => diagnostics.push(event),
    });
    const res = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify({ store: false }),
    });
    const socket = lastSocket();
    const events = [
      {
        type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-late' },
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-late',
        summary_index: 0, delta: 'first',
      },
      {
        type: 'response.reasoning_summary_part.done', item_id: 'reasoning-late', summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_part.added', item_id: 'reasoning-late', summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-late',
        summary_index: 0, delta: 'late',
      },
      { type: 'response.failed', response: { id: 'resp_late', status: 'failed' } },
    ];
    for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
    await readAll(res);

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'ws_response_protocol_anomaly',
      anomaly: 'reasoning_start_missing_before_delta',
      summaryIndex: 0,
      knownSummaryParts: [
        { summaryIndex: 0, state: 'concluded' },
        { summaryIndex: 1, state: 'active' },
      ],
      recentUpstreamEventTypes: [
        'response.output_item.added',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_part.done',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_text.delta',
      ],
    }));
  });

  it('closes the socket when the request is aborted', async () => {
    const controller = new AbortController();
    const wsFetch = createResponsesWebSocketFetch(WS_URL);
    const res = await wsFetch('https://x', { method: 'POST', headers: {}, body: '{}', signal: controller.signal });
    const socket = lastSocket();
    controller.abort();
    await readAll(res);
    expect(socket.close).toHaveBeenCalled();
  });

  it('retains one socket and sends only append-only input with current prompt fields', async () => {
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai', accountId: 'acct-1',
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_1', 'hi');
    await readAll(first);

    expect(socket.close).not.toHaveBeenCalled();

    // A newly-created provider/fetch closure must still find the process-level chain.
    const nextFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai', accountId: 'acct-1',
    });
    const echoedAssistant = { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'again' }] };
    const updatedTools = [
      { type: 'function', name: 'Read', parameters: { type: 'object' } },
      { type: 'function', name: 'Write', parameters: { type: 'object' } },
    ];
    const second = await nextFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...firstInput, echoedAssistant, nextUser], {
        instructions: 'You are a coding assistant. A skill is now active.',
        tools: updatedTools,
      })),
    });

    expect(fakeSockets).toHaveLength(1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_1');
    expect(sent.input).toEqual([nextUser]);
    expect(sent.instructions).toBe('You are a coding assistant. A skill is now active.');
    expect(sent.tools).toEqual(updatedTools);

    emitTextResponse(socket, 'resp_2', 'hello again');
    await readAll(second);
  });

  it('reuses a socket only while the authorization credential is unchanged', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const firstUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'first' }],
    };
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'acct-token-rotation',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-a' },
      body: JSON.stringify(sessionPayload([firstUser])),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_token_a_1', 'first answer');
    await readAll(first);

    const firstAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'second' }],
    };
    const secondInput = [firstUser, firstAssistant, secondUser];
    const second = await wsFetch('https://x', {
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer token-a' }),
      body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(firstSocket, 'resp_token_a_2', 'second answer');
    await readAll(second);

    const secondAssistant = {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second answer' }],
    };
    const thirdUser = {
      role: 'user',
      content: [{ type: 'input_text', text: 'third' }],
    };
    const third = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-b' },
      body: JSON.stringify(sessionPayload([...secondInput, secondAssistant, thirdUser])),
    });

    expect(fakeSockets).toHaveLength(2);
    const replacementSocket = lastSocket();
    expect(firstSocket.close).toHaveBeenCalledOnce();
    expect(replacementSocket).not.toBe(firstSocket);
    expect(replacementSocket.options.headers?.Authorization).toBe('Bearer token-b');
    replacementSocket.emit('open');
    emitTextResponse(replacementSocket, 'resp_token_b_1', 'third answer');
    await readAll(third);
    expect(JSON.stringify(diagnostics)).not.toMatch(/token-[ab]/);
  });

  it('keeps concurrent requests with different credentials on separate sockets', async () => {
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'acct-concurrent-rotation',
    });
    const payload = sessionPayload([{
      role: 'user',
      content: [{ type: 'input_text', text: 'parallel' }],
    }]);

    const first = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-a' },
      body: JSON.stringify(payload),
    });
    const firstSocket = lastSocket();
    const second = await wsFetch('https://x', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-b' },
      body: JSON.stringify(payload),
    });
    const secondSocket = lastSocket();

    expect(fakeSockets).toHaveLength(2);
    expect(firstSocket).not.toBe(secondSocket);
    expect(firstSocket.options.headers?.Authorization).toBe('Bearer token-a');
    expect(secondSocket.options.headers?.Authorization).toBe('Bearer token-b');
    expect(firstSocket.close).not.toHaveBeenCalled();

    firstSocket.emit('open');
    secondSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_concurrent_a', 'first answer');
    emitTextResponse(secondSocket, 'resp_concurrent_b', 'second answer');
    await Promise.all([readAll(first), readAll(second)]);
  });

  it('emits correlated privacy-safe reasons when a history mismatch creates another head', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      providerId: 'openai',
      accountId: 'private-account-id',
      onDiagnostic: event => diagnostics.push(event),
    });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'private first prompt' }] }];
    const first = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-first' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
      }),
    );
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_first', 'private answer');
    await readAll(first);

    const branchInput = [{ role: 'user', content: [{ type: 'input_text', text: 'private divergent prompt' }] }];
    const branch = await withResponsesWebSocketDiagnosticContext(
      { requestId: 'req-branch' },
      () => wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(branchInput)),
      }),
    );
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    emitTextResponse(branchSocket, 'resp_branch', 'private branch answer');
    await readAll(branch);

    const firstDecision = diagnostics.find(event => event.requestId === 'req-first');
    const branchDecision = diagnostics.find(event => event.requestId === 'req-branch');
    expect(firstDecision).toMatchObject({
      event: 'ws_head_decision',
      decision: 'new_partition_head',
      candidateCount: 0,
      createdConnectionId: 1,
      keyTuple: {
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        effort: 'high',
        promptCacheKeyHash: createHash('sha256').update('relay-session-abc').digest('hex').slice(0, 16),
        accountIdHash: expect.any(String),
      },
    });
    expect(branchDecision).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_new_head',
      candidateCount: 1,
      matchingCandidateCount: 0,
      createdConnectionId: 2,
      heads: [{
        connectionId: 1,
        mismatch: {
          firstMismatch: 0,
          expectedKind: 'user',
          actualKind: 'user',
          expectedHash: expect.any(String),
          actualHash: expect.any(String),
        },
      }],
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('private-account-id');
    expect(serialized).not.toContain('relay-session-abc');
    expect(serialized).not.toContain('private first prompt');
    expect(serialized).not.toContain('private divergent prompt');
    expect(serialized).not.toContain('private answer');
    expect(serialized).not.toContain('private branch answer');
  });

  it('continues a tool loop with only the function_call_output', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'read it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-tools' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{ "path": "file.ts", "line": 1 }', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_tool' } })));
    await readAll(first);

    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read',
      arguments: '{"line":1,"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_tool');
    expect(sent.input).toEqual([toolOutput]);
    emitTextResponse(socket, 'resp_done', 'done');
    await readAll(second);
  });

  it('validates encrypted reasoning and exact assistant text before continuing', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'reason' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-reasoning' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'thinking',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_1' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.added', output_index: 1,
      item: { type: 'message', id: 'msg_reason' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_text.delta', item_id: 'msg_reason', delta: 'answer',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: { type: 'message', id: 'msg_reason' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason' } })));
    await readAll(first);

    const reasoning = {
      type: 'reasoning', encrypted_content: 'enc_1',
      summary: [{ type: 'summary_text', text: 'thinking' }],
    };
    const assistant = { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([...input, reasoning, assistant, nextUser])),
    });
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(socket, 'resp_reason_next', 'done');
    await readAll(second);
  });

  it('continues when Claude omits reasoning but exactly echoes the following function call', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-omitted-reasoning',
      onDiagnostic: event => diagnostics.push(event),
    });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read',
        arguments: '{"path":"file.ts"}', status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.completed', response: { id: 'resp_reason_tool' },
    })));
    await readAll(first);

    const echoedCall = {
      type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"file.ts"}',
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {},
      body: JSON.stringify(sessionPayload([...input, echoedCall, toolOutput])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason_tool');
    expect(sent.input).toEqual([toolOutput]);
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'continuation',
      continuationMatchMode: 'omitted_reasoning',
      promotedConnectionId: 1,
      selectedGeneration: 'established',
    });
    emitTextResponse(socket, 'resp_after_tool', 'done');
    await readAll(second);
  });

  it('continues when Claude omits reasoning but exactly echoes the following assistant text', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'answer it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-omitted-reasoning-text' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_text' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: {
        type: 'message', id: 'msg_1',
        content: [{ type: 'output_text', text: 'the answer' }], status: 'completed',
      },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason_text' } })));
    await readAll(first);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] };
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'the answer' }] },
        nextUser,
      ])),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_reason_text');
    expect(sent.input).toEqual([nextUser]);
  });

  it('does not ignore a mismatch in the assistant item after omitted reasoning', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-reasoning-mismatch' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'resp_reason_tool' } })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_private', summary: [] },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.output_item.done', output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}', status: 'completed' },
    })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_reason_tool' } })));
    await readAll(first);

    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { type: 'function_call', call_id: 'call_1', name: 'Write', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
      ])),
    });
    expect(fakeSockets).toHaveLength(2);
  });

  it('isolates an unrelated parallel request and preserves the main chain head', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-parallel' });
    const main = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');

    const auxiliary = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'make a title' }] },
      ])),
    });
    const auxiliarySocket = lastSocket();
    expect(auxiliarySocket).not.toBe(mainSocket);
    auxiliarySocket.emit('open');
    emitTextResponse(auxiliarySocket, 'resp_aux', 'title');
    await readAll(auxiliary);

    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);
    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'next' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
        nextUser,
      ])),
    });
    expect(lastSocket()).toBe(auxiliarySocket); // no new socket was constructed
    const sent = JSON.parse(mainSocket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_main');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(mainSocket, 'resp_next', 'next answer');
    await readAll(next);
  });

  it('retains the main head when a completed auxiliary request starts another branch', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-hidden-branch' });
    const main = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');
    emitTextResponse(mainSocket, 'resp_main', 'main answer');
    await readAll(main);

    // Claude stop hooks/title generation can run after the visible response and
    // inherit the same session/model/effort partition with unrelated history.
    const auxiliaryInput = [{ role: 'user', content: [{ type: 'input_text', text: 'make a title' }] }];
    const auxiliary = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(auxiliaryInput)),
    });
    expect(fakeSockets).toHaveLength(2);
    const auxiliarySocket = lastSocket();
    auxiliarySocket.emit('open');
    emitTextResponse(auxiliarySocket, 'resp_aux', 'title');
    await readAll(auxiliary);
    expect(mainSocket.close).not.toHaveBeenCalled();

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
        nextUser,
      ])),
    });

    expect(fakeSockets).toHaveLength(2);
    const sent = JSON.parse(mainSocket.send.mock.calls[1]![0] as string);
    expect(sent.previous_response_id).toBe('resp_main');
    expect(sent.input).toEqual([nextUser]);
    emitTextResponse(mainSocket, 'resp_main_next', 'you are welcome');
    await readAll(next);
  });

  it('retries previous_response_not_found once on a new socket with full context', async () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-retry' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_old', 'answer');
    await readAll(first);

    const fullNextInput = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(fullNextInput)),
    });
    firstSocket.emit('message', Buffer.from(JSON.stringify({
      type: 'error', status: 400,
      error: { code: 'previous_response_not_found', message: 'gone' },
    })));

    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const retried = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(retried.previous_response_id).toBeUndefined();
    expect(retried.input).toEqual(fullNextInput);
    emitTextResponse(replacement, 'resp_recovered', 'recovered');
    const body = await readAll(second);
    expect(body).not.toContain('previous_response_not_found');
  });

  it('resets a rewind/branch to full context and establishes the branch as the new head', async () => {
    const original = [{ role: 'user', content: [{ type: 'input_text', text: 'original' }] }];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, { accountId: 'acct-branch' });
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(original)),
    });
    const originalSocket = lastSocket();
    originalSocket.emit('open');
    emitTextResponse(originalSocket, 'resp_original', 'original answer');
    await readAll(first);

    const branchInput = [{ role: 'user', content: [{ type: 'input_text', text: 'different branch' }] }];
    const branch = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(branchInput)),
    });
    expect(fakeSockets).toHaveLength(2);
    const branchSocket = lastSocket();
    branchSocket.emit('open');
    const reset = JSON.parse(branchSocket.send.mock.calls[0]![0] as string);
    expect(reset.previous_response_id).toBeUndefined();
    expect(reset.input).toEqual(branchInput);
    emitTextResponse(branchSocket, 'resp_branch', 'branch answer');
    await readAll(branch);

    const nextUser = { role: 'user', content: [{ type: 'input_text', text: 'continue branch' }] };
    const next = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...branchInput,
        { role: 'assistant', content: [{ type: 'output_text', text: 'branch answer' }] },
        nextUser,
      ])),
    });
    const continued = JSON.parse(branchSocket.send.mock.calls[1]![0] as string);
    expect(continued.previous_response_id).toBe('resp_branch');
    expect(continued.input).toEqual([nextUser]);
    emitTextResponse(branchSocket, 'resp_branch_next', 'done');
    await readAll(next);
  });

  it('expires an idle chain and restarts with full context', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-ttl', idleTtlMs: 100, hardTtlMs: 1_000, now: () => now,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const firstSocket = lastSocket();
    firstSocket.emit('open');
    emitTextResponse(firstSocket, 'resp_ttl', 'answer');
    await readAll(first);

    now += 101;
    const full = [...input, { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] }];
    await wsFetch('https://x', { method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(full)) });
    expect(fakeSockets).toHaveLength(2);
    const replacement = lastSocket();
    replacement.emit('open');
    const sent = JSON.parse(replacement.send.mock.calls[0]![0] as string);
    expect(sent.previous_response_id).toBeUndefined();
    expect(sent.input).toEqual(full);
  });

  it('starts and resumes TTL clocks only after each response stream finishes', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-paused-ttl',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 100,
      hardTtlMs: 100,
      now: () => now,
    });
    const firstInput = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(firstInput)),
    });
    const socket = lastSocket();
    socket.emit('open');

    // The initial stream lasts far longer than every TTL, but none of that
    // in-flight time should age the retained head.
    now = 2_000;
    emitTextResponse(socket, 'resp_pause_1', 'answer one');
    await readAll(first);

    now = 2_050;
    const secondInput = [
      ...firstInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);

    // Suspend the already-running clocks during another long response.
    now = 3_050;
    emitTextResponse(socket, 'resp_pause_2', 'answer two');
    await readAll(second);

    now = 3_099;
    const thirdInput = [
      ...secondInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ];
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(thirdInput)),
    });

    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_pause_2');
  });

  it('promotes a continued nursery head and preserves it past the nursery TTL at capacity', async () => {
    let now = 1_000;
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-generations',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 1_000,
      hardTtlMs: 10_000,
      maxConnections: 1,
      now: () => now,
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_gen_1', 'answer one');
    await readAll(first);

    now += 50;
    const secondInput = [
      ...input,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(secondInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    emitTextResponse(socket, 'resp_gen_2', 'answer two');
    await readAll(second);

    now += 150;
    const thirdInput = [
      ...secondInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'three' }] },
    ];
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(thirdInput)),
    });
    expect(fakeSockets).toHaveLength(1);
    const sent = JSON.parse(socket.send.mock.calls[2]![0] as string);
    expect(sent.previous_response_id).toBe('resp_gen_2');
  });

  it('expires an unpromoted head on the shorter nursery TTL', async () => {
    let now = 1_000;
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-nursery-ttl',
      nurseryIdleTtlMs: 100,
      idleTtlMs: 1_000,
      hardTtlMs: 10_000,
      now: () => now,
      onDiagnostic: event => diagnostics.push(event),
    });
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
    });
    const socket = lastSocket();
    socket.emit('open');
    emitTextResponse(socket, 'resp_nursery', 'answer');
    await readAll(first);

    now += 101;
    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        ...input,
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
      ])),
    });

    expect(fakeSockets).toHaveLength(2);
    expect(socket.close).toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'new_partition_head',
      evictions: [{
        connectionId: 1,
        generation: 'nursery',
        reason: 'nursery_idle_ttl',
      }],
    });
  });

  it('keeps separate nursery capacity and evicts there without displacing a full established LRU', async () => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
      accountId: 'acct-generation-lru',
      maxConnections: 1,
      maxNurseryConnections: 1,
      onDiagnostic: event => diagnostics.push(event),
    });
    const mainInput = [{ role: 'user', content: [{ type: 'input_text', text: 'main' }] }];
    const first = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(mainInput)),
    });
    const mainSocket = lastSocket();
    mainSocket.emit('open');
    emitTextResponse(mainSocket, 'resp_main_1', 'main answer');
    await readAll(first);

    const mainNext = [
      ...mainInput,
      { role: 'assistant', content: [{ type: 'output_text', text: 'main answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'continue main' }] },
    ];
    const second = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(mainNext)),
    });
    emitTextResponse(mainSocket, 'resp_main_2', 'continued');
    await readAll(second);

    const branch = await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'branch one' }] },
      ])),
    });
    const nurserySocket = lastSocket();
    nurserySocket.emit('open');
    emitTextResponse(nurserySocket, 'resp_branch_1', 'branch answer');
    await readAll(branch);
    expect(fakeSockets).toHaveLength(2);
    expect(mainSocket.close).not.toHaveBeenCalled();
    expect(nurserySocket.close).not.toHaveBeenCalled();

    await wsFetch('https://x', {
      method: 'POST', headers: {}, body: JSON.stringify(sessionPayload([
        { role: 'user', content: [{ type: 'input_text', text: 'branch two' }] },
      ])),
    });

    expect(fakeSockets).toHaveLength(3);
    expect(nurserySocket.close).toHaveBeenCalled();
    expect(mainSocket.close).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'ws_head_decision',
      decision: 'history_mismatch_new_head',
      evictions: [{
        connectionId: 2,
        generation: 'nursery',
        reason: 'nursery_lru_cap',
      }],
    });
  });

  it('partitions by provider, account, model, effort, session, and credential fingerprint', () => {
    const payload = sessionPayload([]);
    const options = { providerId: 'openai', accountId: 'a' };
    const base = responsesWebSocketPartitionKey(WS_URL, payload, options, 'credential-a');
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      { providerId: 'other', accountId: 'a' },
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      { providerId: 'openai', accountId: 'b' },
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, model: 'gpt-other' },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, reasoning: { effort: 'low' } },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      { ...payload, prompt_cache_key: 'other-session' },
      options,
      'credential-a',
    ));
    expect(base).not.toBe(responsesWebSocketPartitionKey(
      WS_URL,
      payload,
      options,
      'credential-b',
    ));
    expect(base).toBe(responsesWebSocketPartitionKey(WS_URL, {
      ...payload,
      instructions: 'changed',
      tools: [{ type: 'function', name: 'Write' }],
    }, options, 'credential-a'));
  });

  it('canonicalizes object key ordering in prompt fingerprints', () => {
    expect(responsesWebSocketPromptFingerprint({ model: 'm', tools: [{ name: 'x', parameters: { b: 2, a: 1 } }], input: ['a'] }))
      .toBe(responsesWebSocketPromptFingerprint({ tools: [{ parameters: { a: 1, b: 2 }, name: 'x' }], model: 'm', input: ['different'] }));
  });
});
