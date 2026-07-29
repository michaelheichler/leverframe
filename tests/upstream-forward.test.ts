import type { ServerResponse } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
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
