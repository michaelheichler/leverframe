import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestGitHubCopilotDeviceCode, pollGitHubCopilotDeviceCodeToken } from '../src/oauth/github-copilot.js';

const device = {
  device_code: 'fixture-device-code',
  user_code: 'FAKE-1234',
  verification_uri: 'https://github.test/device',
  expires_in: 900,
  interval: 1,
};

const operations = [
  ['device', (signal?: AbortSignal) => requestGitHubCopilotDeviceCode(signal)],
  ['poll', (signal?: AbortSignal) => pollGitHubCopilotDeviceCodeToken(device, {
    now: Date.now,
    sleep: async () => {},
    signal,
  })],
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GitHub OAuth response body deadlines', () => {
  it.each(operations.flatMap(([name, operation]) => [200, 400].map(status => [name, status, operation] as const)))(
    'bounds a stalled %s HTTP %i body', async (_name, status, operation) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          requestSignal?.addEventListener('abort', () => controller.error(requestSignal?.reason), { once: true });
        },
      }), { status });
    }));
    const outcome = operation().then(() => 'resolved', error => String(error));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(requestSignal?.aborted).toBe(true);
    await expect(outcome).resolves.toMatch(/timed out/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations)('cancels a stalled %s body on caller abort', async (_name, operation) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }))));
    const outcome = operation(abort.signal).then(() => 'resolved', error => String(error));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new Error('fixture cancellation'));
    await expect(outcome).resolves.toBe('Error: GitHub Copilot device authorization aborted');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('GitHub OAuth polling response cleanup', () => {
  it.each(['reject', 'pending'])('retries without waiting for %s cleanup', async mode => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => mode === 'reject' ? Promise.reject(new Error('cleanup failed')) : new Promise<void>(() => {}));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fixture-access-token', token_type: 'bearer', scope: '' }));
    vi.stubGlobal('fetch', fetch);
    const outcome = pollGitHubCopilotDeviceCodeToken(device, { now: Date.now, sleep: async () => {} })
      .then(value => value, error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(outcome).resolves.toEqual({ tokens: { access_token: 'fixture-access-token' } });
  });
  it('cancels a retryable response body before polling again', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fixture-access-token', token_type: 'bearer', scope: '' }));
    vi.stubGlobal('fetch', fetch);
    await expect(pollGitHubCopilotDeviceCodeToken(device, {
      now: Date.now, sleep: async () => {},
    })).resolves.toEqual({ tokens: { access_token: 'fixture-access-token' } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
