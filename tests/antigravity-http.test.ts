import { describe, expect, it, vi } from 'vitest';
import {
  createAntigravityFetch,
} from '../src/antigravity/backend.js';
import type { AntigravityAuthSnapshot } from '../src/antigravity/types.js';

const auth: AntigravityAuthSnapshot = {
  accessToken: 'account-a-access', accountId: 'account-a', projectId: 'project-a',
};

function sdkRequest(modelId: string, body: Record<string, unknown>): Request {
  return new Request(`https://daily-cloudcode-pa.googleapis.com/v1beta/models/${modelId}:generateContent?key=public-sdk-key`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': 'public-sdk-key',
      'x-leverframe-antigravity-session': 'session-one',
      'x-untrusted-client-header': 'must-not-forward',
    },
    body: JSON.stringify(body),
  });
}

describe('Antigravity HTTP adapter', () => {
  it('sends an authenticated subscription envelope and returns Google response data', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ response: {
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      usageMetadata: { promptTokenCount: 8 },
    } }));
    const request = createAntigravityFetch({ resolveAuth: async () => auth, fetchImpl });
    const upstream = await request(sdkRequest('gemini-3.1-pro-high', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 128 },
    }));

    expect(await upstream.json()).toEqual({
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      usageMetadata: { promptTokenCount: 8 },
    });
    expect(upstream.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer account-a-access');
    expect(new Headers(init?.headers).has('x-goog-api-key')).toBe(false);
    expect(new Headers(init?.headers).has('x-untrusted-client-header')).toBe(false);
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      project: 'project-a', model: 'gemini-3.1-pro-high',
      request: {
        sessionId: 'session-one',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        generationConfig: { maxOutputTokens: 128 },
      },
    });
  });
});

  it('rejects a non-subscription SDK destination before network access', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
    const request = createAntigravityFetch({ resolveAuth: async () => auth, fetchImpl });
    const input = new Request('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-high:generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [] }),
    });

    await expect(request(input)).rejects.toMatchObject({ statusCode: 400 });

    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it.each(['enabledCreditTypes', 'enabled_credit_types'])('rejects a caller credit field named %s before network access', async field => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
    const request = createAntigravityFetch({ resolveAuth: async () => auth, fetchImpl });

    await expect(request(sdkRequest('gemini-3.1-pro-high', {
      contents: [], [field]: ['GOOGLE_ONE_AI'],
    }))).rejects.toThrow(/credit|billing|unsupported/i);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('surfaces a quota rejection after one upstream attempt', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED' },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const request = createAntigravityFetch({ resolveAuth: async () => auth, fetchImpl });

    await expect(request(sdkRequest('gemini-3.1-pro-high', { contents: [] })))
      .rejects.toMatchObject({ statusCode: 429 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves a bounded retry delay from structured quota metadata without retrying', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{
        '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '60s',
      }] },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const request = createAntigravityFetch({ resolveAuth: async () => auth, fetchImpl });

    await expect(request(sdkRequest('gemini-3.1-pro-high', { contents: [] })))
      .rejects.toMatchObject({ statusCode: 429, retryAfterMs: 60_000 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh access token and project snapshot for each call on one transport', async () => {
    const resolveAuth = vi.fn()
      .mockResolvedValueOnce({ ...auth, accessToken: 'first-token' })
      .mockResolvedValueOnce({ ...auth, accessToken: 'rotated-token', projectId: 'project-b' });
    const outgoing: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      outgoing.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ response: { candidates: [] } });
    });
    const request = createAntigravityFetch({ resolveAuth, fetchImpl });

    await request(sdkRequest('gemini-3.1-pro-high', { contents: [] }));
    await request(sdkRequest('gemini-3.1-pro-high', { contents: [] }));

    expect(outgoing.map(call => call.headers.get('authorization'))).toEqual(['Bearer first-token', 'Bearer rotated-token']);
    expect(outgoing.map(call => call.body['project'])).toEqual(['project-a', 'project-b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not resolve credentials or access the network for an already aborted request', async () => {
    const resolveAuth = vi.fn(async () => auth);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
    const request = createAntigravityFetch({ resolveAuth, fetchImpl });
    const controller = new AbortController();
    controller.abort();
    const aborted = new Request(sdkRequest('gemini-3.1-pro-high', { contents: [] }), { signal: controller.signal });

    await expect(request(aborted)).rejects.toThrow();

    expect(resolveAuth).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a redirect instead of forwarding subscription credentials', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 307, headers: { location: 'https://outside.example/' } }));
    const request = createAntigravityFetch({ resolveAuth: async () => auth, fetchImpl });

    await expect(request(sdkRequest('gemini-3.1-pro-high', { contents: [] })))
      .rejects.toThrow(/redirect/i);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
