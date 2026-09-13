/** Because unchecked URLs can leak OAuth credentials. */
import { describe, expect, it, vi } from 'vitest';
import { VERSION } from '../src/constants.js';
import { createCopilotFetch, fetchCopilotModels } from '../src/copilot/backend.js';

const TOKEN = globalThis.crypto.randomUUID();
const API = 'https://api.githubcopilot.com';

describe('direct Copilot HTTP authentication', () => {
  it('uses the GitHub OAuth token directly without an exchange or runtime', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const send = createCopilotFetch(TOKEN, network);
    await send(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder', 'x-api-key': 'other-provider-secret', cookie: 'private-cookie' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(network).toHaveBeenCalledTimes(1);
    const request = network.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`${API}/chat/completions`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get('user-agent')).toBe(`leverframe/${VERSION}`);
    expect(request.headers.get('editor-version')).toBe(`leverframe/${VERSION}`);
    expect(request.headers.get('x-github-api-version')).toBe('2025-05-01');
    expect(request.headers.has('x-api-key')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.has('copilot-integration-id')).toBe(false);
    expect(request.redirect).toBe('manual');
    expect(await request.json()).toMatchObject({ model: 'gpt-4o-mini' });
  });
});

describe('Copilot endpoint restrictions', () => {
  it.each([
    'https://evil.example/chat/completions', 'https://api.githubcopilot.com.evil.example/chat/completions',
    'http://api.githubcopilot.com/chat/completions', 'https://user:secret@api.githubcopilot.com/chat/completions',
    'https://api.githubcopilot.com/chat/completions?token=secret', 'https://api.githubcopilot.com/unexpected',
  ])('rejects an unapproved endpoint without sending credentials %s', async url => {
    const network = vi.fn<typeof fetch>();
    await expect(createCopilotFetch(TOKEN, network)(url)).rejects.toThrow(/endpoint|URL/i);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['', '   ', 'secret\r\nheader:value'])('rejects malformed credentials without echoing them', token => {
    expect(() => createCopilotFetch(token)).toThrow('GitHub Copilot requires a valid GitHub OAuth credential.');
  });
});

describe('Copilot HTTP lifecycle', () => {
  it('keeps the caller abort signal and Anthropic protocol headers', async () => {
    const controller = new AbortController();
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await createCopilotFetch(TOKEN, network)(new Request(`${API}/v1/messages`, {
      method: 'POST', signal: controller.signal,
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'example-beta', 'content-type': 'application/json' },
      body: '{}',
    }));
    const request = network.mock.calls[0]![0] as Request;
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request.headers.get('anthropic-beta')).toBe('example-beta');
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });
  it('does not send an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const network = vi.fn<typeof fetch>();
    await expect(createCopilotFetch(TOKEN, network)(`${API}/models`, { signal: controller.signal })).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it('does not follow a redirect or expose its target', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 307, headers: { location: `https://evil.example/${TOKEN}` },
    }));
    await expect(createCopilotFetch(TOKEN, network)(`${API}/models`)).rejects.toThrow('GitHub Copilot returned an unsupported redirect.');
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('redacts the OAuth credential from error responses', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: `Rejected ${TOKEN}` } }), {
      status: 401, headers: { 'content-type': 'application/json', 'x-diagnostic': TOKEN },
    }));
    const response = await createCopilotFetch(TOKEN, network)(`${API}/models`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(TOKEN);
    expect(response.headers.get('x-diagnostic')).toBe('[redacted]');
  });
});

describe('direct Copilot model catalog', () => {
  it('reads the authenticated data array with the metadata API version', async () => {
    const models = [{ id: 'gpt-4o-mini', capabilities: { type: 'chat' } }];
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: models, object: 'list' }));
    await expect(fetchCopilotModels(TOKEN, { fetchImpl: network })).resolves.toEqual(models);
    const request = network.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`${API}/models`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get('x-github-api-version')).toBe('2025-10-01');
  });
  it.each([401, 403, 429, 500])('preserves HTTP failure status %s without exposing response secrets', async status => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(TOKEN, { status }));
    await expect(fetchCopilotModels(TOKEN, { fetchImpl: network })).rejects.toMatchObject({ statusCode: status });
  });
  it.each([{}, { data: null }, { data: {} }])('rejects malformed catalog envelopes', async envelope => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope));
    await expect(fetchCopilotModels(TOKEN, { fetchImpl: network })).rejects.toThrow(/invalid model catalog/i);
  });
  it('rejects oversized metadata and cancels the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel,
    });
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(fetchCopilotModels(TOKEN, { fetchImpl: network })).rejects.toThrow(/size limit/i);
    expect(cancel).toHaveBeenCalled();
  });
});
