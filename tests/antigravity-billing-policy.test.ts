import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAntigravityFetch } from '../src/antigravity/backend.js';
import {
  assertAntigravityBillingAllowed,
  clearAntigravityBillingLatch,
  recordAntigravityCreditConsumption,
} from '../src/antigravity/billing-policy.js';

async function withBillingHome(operation: (home: string) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-billing-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  try {
    await operation(home);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}

function creditUse(amount: string) {
  return { consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: amount }] };
}

function requestBody() {
  return JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
}

function jsonRequest(): Request {
  return new Request('https://daily-cloudcode-pa.googleapis.com/v1beta/models/gemini-3.1-pro-high:generateContent', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-leverframe-antigravity-session': 'session',
    }, body: requestBody(),
  });
}

function streamingRequest(): Request {
  return new Request('https://daily-cloudcode-pa.googleapis.com/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-leverframe-antigravity-session': 'session',
    }, body: requestBody(),
  });
}

function accountAdapter(fetchImpl: typeof fetch) {
  return createAntigravityFetch({
    resolveAuth: async () => ({ accountId: 'account-a', accessToken: 'token', projectId: 'project' }),
    fetchImpl,
  });
}

describe('Antigravity account credit latch', () => {
  it('blocks future requests after the response reports consumed credits', () => withBillingHome(() => {
    recordAntigravityCreditConsumption('account-a', creditUse('3'));

    expect(() => assertAntigravityBillingAllowed('account-a')).toThrow(/credit|billing/i);
  }));

  it('keeps accounts independent when one account consumed credits', () => withBillingHome(() => {
    recordAntigravityCreditConsumption('account-a', creditUse('2'));

    expect(() => assertAntigravityBillingAllowed('account-b')).not.toThrow();
  }));

  it('allows further requests when the backend reports zero credits consumed', () => withBillingHome(() => {
    recordAntigravityCreditConsumption('account-a', {
      consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '0' }],
      remainingCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '20' }],
    });

    expect(() => assertAntigravityBillingAllowed('account-a')).not.toThrow();
  }));
});

describe('Antigravity persisted credit latch', () => {
  it('keeps the account blocked across a provider process restart', () => withBillingHome(async () => {
    recordAntigravityCreditConsumption('account-a', creditUse('1'));
    vi.resetModules();

    const freshModule = await import('../src/antigravity/billing-policy.js');
    expect(() => freshModule.assertAntigravityBillingAllowed('account-a')).toThrow(/credit|billing/i);
  }));

  it('blocks an unreadable latch rather than assuming the account is safe', () => withBillingHome(home => {
    const accountDir = join(home, 'antigravity', 'billing');
    recordAntigravityCreditConsumption('account-a', creditUse('1'));
    const files = readdirSync(accountDir);
    writeFileSync(join(accountDir, files[0]!), '{', { mode: 0o600 });

    expect(() => assertAntigravityBillingAllowed('account-a')).toThrow(/billing|latch|state/i);
  }));

  it('allows explicit recovery after the user reviews the failure', () => withBillingHome(() => {
    recordAntigravityCreditConsumption('account-a', creditUse('1'));
    clearAntigravityBillingLatch('account-a');

    expect(() => assertAntigravityBillingAllowed('account-a')).not.toThrow();
  }));

  it('blocks when the backend returns malformed credit amounts', () => withBillingHome(() => {
    recordAntigravityCreditConsumption('account-a', creditUse('unknown'));

    expect(() => assertAntigravityBillingAllowed('account-a')).toThrow(/credit|billing/i);
  }));
});

describe('Antigravity inference billing enforcement', () => {
  it('fails a JSON response and blocks the next request after credit consumption', () => withBillingHome(async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      response: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] },
      ...creditUse('3'),
    }));
    const adapter = accountAdapter(fetchImpl);
    const response = await adapter(jsonRequest());

    await expect(response.json()).rejects.toMatchObject({ statusCode: 409 });
    await expect(adapter(jsonRequest())).rejects.toThrow(/credit|billing/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }));

  it('fails a streamed response and blocks the next request after credit consumption', () => withBillingHome(async () => {
    const event = `data: ${JSON.stringify({ response: { candidates: [] }, ...creditUse('1') })}`;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      `${event}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } },
    ));
    const adapter = accountAdapter(fetchImpl);
    const response = await adapter(streamingRequest());

    await expect(response.text()).rejects.toMatchObject({ statusCode: 409 });
    await expect(adapter(streamingRequest())).rejects.toThrow(/credit|billing/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }));
});

describe('Antigravity error response billing enforcement', () => {
  it('latches positive consumed credits even when the inference response is non-success', () => withBillingHome(async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED' }, ...creditUse('1'),
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const adapter = accountAdapter(fetchImpl);

    await expect(adapter(jsonRequest())).rejects.toMatchObject({ statusCode: 409 });
    await expect(adapter(jsonRequest())).rejects.toThrow(/billing|credit/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }));
});
