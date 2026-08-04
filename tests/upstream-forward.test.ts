import type { ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previousHeartbeat = process.env['LEVERFRAME_SSE_HEARTBEAT_MS'];
afterEach(() => {
  if (previousHeartbeat === undefined) delete process.env['LEVERFRAME_SSE_HEARTBEAT_MS'];
  else process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = previousHeartbeat;
});

function streamedResponse(): ServerResponse {
  const response = new PassThrough() as PassThrough & ServerResponse;
  let headersWereSent = false;
  Object.defineProperty(response, 'headersSent', { get: () => headersWereSent });
  response.writeHead = vi.fn(() => {
    headersWereSent = true;
    return response;
  }) as typeof response.writeHead;
  return response;
}

function responseBody(response: Writable): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

import { anthropicUpstreamHeaders, fetchWithOAuthRetry, relayAnthropicMessages } from '../src/upstream-forward.js';

describe('anthropicUpstreamHeaders', () => {
  it('uses x-api-key for API-key auth', () => {
    expect(anthropicUpstreamHeaders('secret-key')).toMatchObject({
      Authorization: 'Bearer secret-key',
      'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('adds stream accept header when requested', () => {
    expect(anthropicUpstreamHeaders('secret-key', true).Accept).toBe('text/event-stream');
  });

  it('uses bearer-only OAuth headers and preserves the OAuth beta', () => {
    const headers = anthropicUpstreamHeaders(
      'oauth-token',
      true,
      'oauth-2025-04-20',
      'oauth',
      'session-123',
    );

    expect(headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-cli/2.1.195 (external, cli)',
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': 'session-123',
    });
    expect(headers).not.toHaveProperty('x-api-key');
  });
});

describe('relayAnthropicMessages', () => {
  it('writes an SSE error frame when a stream fails after output', async () => {
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '0';
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {}\n\n'));
        setTimeout(() => controller.error(new Error('upstream socket failed')), 5);
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const response = streamedResponse();
    const body = responseBody(response);

    try {
      await relayAnthropicMessages(response, 'https://api.anthropic.test/v1/messages', { model: 'claude-test' }, 'key', true);
      const text = await body;
      const errorFrame = text.split('\n\n').find(frame => frame.startsWith('event: error\n'));
      expect(errorFrame).toBeDefined();
      const errorData = errorFrame?.split('\n').find(line => line.startsWith('data: '));
      expect(errorData).toBeDefined();
      if (!errorData) throw new Error('error data frame missing');
      expect(JSON.parse(errorData.slice('data: '.length))).toMatchObject({
        type: 'error',
        error: { message: 'upstream socket failed' },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('waits for a complete SSE event before injecting a heartbeat', async () => {
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '10';
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start'));
        setTimeout(() => controller.enqueue(encoder.encode('\ndata: {}\n\n')), 25);
        setTimeout(() => controller.close(), 50);
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const response = streamedResponse();
    const body = responseBody(response);

    try {
      await relayAnthropicMessages(response, 'https://api.anthropic.test/v1/messages', { model: 'claude-test' }, 'key', true);
      const text = await body;
      const pingIndex = text.indexOf(': ping\n\n');
      const eventEnd = text.indexOf('data: {}\n\n') + 'data: {}\n\n'.length;
      expect(pingIndex).toBeGreaterThanOrEqual(eventEnd);
      expect(text.slice(0, eventEnd)).not.toContain(': ping');
      const pingFrame = text.split('\n\n').find(frame => frame === ': ping');
      expect(pingFrame).toBe(': ping');
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('fetchWithOAuthRetry', () => {
  it('refreshes once on 401 and retries with the refreshed token', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(200);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, 'old-token');
    expect(request).toHaveBeenNthCalledWith(2, 'new-token');
  });

  it('awaits refreshed-token adoption before exposing the retried response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"type":"message"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    let releaseAdoption: (() => void) | undefined;
    const adoptionGate = new Promise<void>(resolve => { releaseAdoption = resolve; });
    const onTokenRefreshed = vi.fn(async () => adoptionGate);
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    try {
      const relay = relayAnthropicMessages(
        response,
        'https://api.anthropic.test/v1/messages',
        { model: 'claude-test' },
        'old-token',
        false,
        { refreshToken: async () => 'new-token', onTokenRefreshed },
      );
      await vi.waitFor(() => expect(onTokenRefreshed).toHaveBeenCalledWith('new-token'));
      expect(response.end).not.toHaveBeenCalled();

      releaseAdoption?.();
      await relay;
      expect(response.end).toHaveBeenCalledWith('{"type":"message"}');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
