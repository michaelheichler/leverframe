import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { classifyPoolFailure } from '../src/account-pool-dispatch.js';
import { savePreferences } from '../src/config.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { messageResponse, listen } from './fixtures/account-pool-proxy.js';

const CREDIT_BALANCE_MESSAGE = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const CREDIT_BALANCE_BODY = JSON.stringify({
  type: 'error', error: { type: 'invalid_request_error', message: CREDIT_BALANCE_MESSAGE },
});
const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-credit-failover-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('ANTHROPIC_PRIMARY_CREDIT_FIXTURE', 'primary-api-key');
  vi.stubEnv('ANTHROPIC_SECONDARY_CREDIT_FIXTURE', 'secondary-api-key');
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
    authType: 'api', authRef: 'env:ANTHROPIC_PRIMARY_CREDIT_FIXTURE', api: {}, addedAt: '2026-11-02',
    accounts: [
      { id: 'primary', authRef: 'env:ANTHROPIC_PRIMARY_CREDIT_FIXTURE', enabled: true },
      { id: 'secondary', authRef: 'env:ANTHROPIC_SECONDARY_CREDIT_FIXTURE', enabled: true },
    ],
  }] });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it.each(['anthropic', 'anthropic-api'])('classifies confirmed low-credit 400 responses as account billing exhaustion for %s', provider => {
  const observation = classifyPoolFailure({
    provider, accountId: 'primary', statusCode: 400, body: CREDIT_BALANCE_BODY,
    headers: new Headers({ 'content-type': 'application/json' }), now: Date.now(),
  });

  expect(observation).toMatchObject({
    accountId: 'primary', scope: { kind: 'account' }, status: 'exhausted', source: expect.stringContaining('billing'),
  });
});

it('does not classify unrelated invalid-request 400 responses as account billing failures', () => {
  const observation = classifyPoolFailure({
    provider: 'anthropic', accountId: 'primary', statusCode: 400,
    body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'The requested token limit is invalid.' } }),
    headers: new Headers(), now: Date.now(),
  });

  expect(observation).toBeUndefined();
});

it('does not classify credit wording with an unrelated error type as account billing failure', () => {
  const observation = classifyPoolFailure({
    provider: 'anthropic', accountId: 'primary', statusCode: 400,
    body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: CREDIT_BALANCE_MESSAGE } }),
    headers: new Headers(), now: Date.now(),
  });

  expect(observation).toBeUndefined();
});

it.each([
  {
    provider: 'custom-api', statusCode: 402,
    body: JSON.stringify({ error: { type: 'billing_error', message: 'Billing action is required.' } }),
  },
])('classifies typed billing exhaustion as account scoped for $provider HTTP $statusCode', ({ provider, statusCode, body }) => {
  const observation = classifyPoolFailure({
    provider, accountId: 'primary', statusCode, body, headers: new Headers(), now: Date.now(),
  });

  expect(observation).toMatchObject({
    accountId: 'primary', scope: { kind: 'account' }, status: 'exhausted', source: expect.stringMatching(/:billing$/),
  });
});

it.each([
  { provider: 'openai', field: 'type', error: { type: 'insufficient_quota' } },
  { provider: 'openai', field: 'code', error: { code: 'insufficient_quota' } },
  { provider: 'custom-api', field: 'status', error: { status: 'insufficient_quota' } },
])('recognizes insufficient_quota from the $field field for $provider', ({ provider, error }) => {
  const observation = classifyPoolFailure({
    provider, accountId: 'primary', statusCode: 429,
    body: JSON.stringify({ error }), headers: new Headers(), now: Date.now(),
  });

  expect(observation).toMatchObject({
    accountId: 'primary', scope: { kind: 'account' }, status: 'exhausted', source: expect.stringMatching(/:billing$/),
  });
});

it.each([
  {
    provider: 'google', body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
  },
  {
    provider: 'openai', body: JSON.stringify({ error: { type: 'tokens', code: 'rate_limit_exceeded' } }),
  },
  { provider: 'custom-api', body: 'upstream temporarily unavailable' },
])('preserves observed HTTP 429 as quota for $provider', ({ provider, body }) => {
  const observation = classifyPoolFailure({
    provider, accountId: 'primary', statusCode: 429, body, headers: new Headers(), now: Date.now(),
  });

  expect(observation).toMatchObject({
    accountId: 'primary', scope: { kind: 'pool' }, status: 'rate_limited', source: expect.stringMatching(/:rejection$/),
  });
});

it('treats an unstructured HTTP 402 as payment-required billing', () => {
  const observation = classifyPoolFailure({
    provider: 'custom-api', accountId: 'primary', statusCode: 402,
    body: JSON.stringify({ error: { code: 402, message: 'Insufficient credits.' } }), headers: new Headers(), now: Date.now(),
  });

  expect(observation).toMatchObject({
    accountId: 'primary', scope: { kind: 'account' }, status: 'exhausted', source: expect.stringMatching(/:billing$/),
  });
});

it.each([
  {
    provider: 'google', statusCode: 429,
    body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }),
    expected: { scope: { kind: 'pool' }, status: 'rate_limited', source: expect.stringMatching(/:rejection$/) },
  },
  {
    provider: 'openai', statusCode: 429,
    body: JSON.stringify({ error: { type: 'tokens', code: 'rate_limit_exceeded' } }),
    expected: { scope: { kind: 'pool' }, status: 'rate_limited', source: expect.stringMatching(/:rejection$/) },
  },
  {
    provider: 'custom-api', statusCode: 429, body: 'upstream temporarily unavailable',
    expected: { scope: { kind: 'pool' }, status: 'rate_limited', source: expect.stringMatching(/:rejection$/) },
  },
  {
    provider: 'custom-api', statusCode: 402,
    body: JSON.stringify({ error: { code: 402, message: 'Insufficient credits.' } }),
    expected: { scope: { kind: 'account' }, status: 'exhausted', source: expect.stringMatching(/:billing$/) },
  },
])('$provider HTTP $statusCode response preserves its billing or quota classification', ({ provider, statusCode, body, expected }) => {
  const observation = classifyPoolFailure({
    provider, accountId: 'primary', statusCode, body, headers: new Headers(), now: Date.now(),
  });

  expect(observation).toMatchObject({ accountId: 'primary', ...expected });
});

async function startCreditUpstream(emptyAccountKeys: string[] = ['primary-api-key']): Promise<{
  port: number;
  calls: Array<{ apiKey: string | undefined; system: string }>;
  close: () => Promise<void>;
}> {
  const calls: Array<{ apiKey: string | undefined; system: string }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { system?: unknown };
    const headerValue = request.headers['x-api-key'];
    const apiKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    calls.push({
      apiKey,
      system: JSON.stringify(body.system ?? null),
    });
    if (emptyAccountKeys.includes(apiKey ?? '')) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(CREDIT_BALANCE_BODY);
    } else {
      messageResponse(response);
    }
  });
  const port = await listen(server);
  return {
    port, calls,
    close: async () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function route(upstreamUrl: string, accountId?: string): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture', realModelId: 'claude-native-fixture',
    displayName: 'Native fixture model', upstreamUrl, apiKey: 'route-snapshot-key',
    modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', providerId: 'anthropic-api', authType: 'api',
    ...(accountId ? { accountId } : {}),
  };
}

function postMessages(port: number, token: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model: 'anthropic-api__claude-native-fixture', max_tokens: 20, stream: false,
    system: 'You are Claude Code.\nx-anthropic-billing-header: client-marker\nHelp with the task.',
    messages: [{ role: 'user', content: 'fixture request' }],
  });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

it('fails over from a native low-credit 400 to a healthy account with neutralized requests', async () => {
  const upstream = await startCreditUpstream();
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ content: [{ text: 'alternate account response' }] });
    expect(upstream.calls.map(call => call.apiKey)).toEqual(['primary-api-key', 'secondary-api-key']);
    expect(JSON.stringify(upstream.calls)).not.toContain('Claude Code');
    expect(JSON.stringify(upstream.calls)).not.toContain('x-anthropic-billing-header');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('remembers a confirmed empty account before the next automatic request', async () => {
  const upstream = await startCreditUpstream();
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const first = await postMessages(proxy.port, proxy.token);
    const second = await postMessages(proxy.port, proxy.token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(upstream.calls.map(call => call.apiKey)).toEqual([
      'primary-api-key', 'secondary-api-key', 'secondary-api-key',
    ]);
    expect(JSON.stringify(upstream.calls)).not.toContain(CREDIT_BALANCE_MESSAGE);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('returns a dedicated message after both configured accounts are confirmed empty', async () => {
  const upstream = await startCreditUpstream(['primary-api-key', 'secondary-api-key']);
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);
    const body = JSON.parse(response.body) as { error?: { message?: string } };
    const message = body.error?.message ?? '';

    expect(response.status).toBe(400);
    expect(message).toContain('Both accounts are empty');
    expect(message).not.toContain(CREDIT_BALANCE_MESSAGE);
    expect(upstream.calls.map(call => call.apiKey)).toEqual(['primary-api-key', 'secondary-api-key']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('reports the configured account count after all accounts are confirmed empty', async () => {
  vi.stubEnv('ANTHROPIC_TERTIARY_CREDIT_FIXTURE', 'tertiary-api-key');
  const registry = loadRegistry();
  registry.providers[0]!.accounts!.push({
    id: 'tertiary', authRef: 'env:ANTHROPIC_TERTIARY_CREDIT_FIXTURE', enabled: true,
  });
  saveRegistry(registry);
  const upstream = await startCreditUpstream(['primary-api-key', 'secondary-api-key', 'tertiary-api-key']);
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);
    const body = JSON.parse(response.body) as { error?: { message?: string } };
    const message = body.error?.message ?? '';

    expect(response.status).toBe(400);
    expect(message).toMatch(/3 accounts.*empty|empty.*3 accounts/i);
    expect(message).not.toContain(CREDIT_BALANCE_MESSAGE);
    expect(upstream.calls.map(call => call.apiKey)).toEqual([
      'primary-api-key', 'secondary-api-key', 'tertiary-api-key',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('does not fail over from a named account after its native low-credit 400', async () => {
  const upstream = await startCreditUpstream();
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`, 'primary')], 'anthropic-api__claude-native-fixture');

  try {
    const response = await postMessages(proxy.port, proxy.token);

    expect(response.status).toBe(400);
    expect(response.body).toContain(CREDIT_BALANCE_MESSAGE);
    expect(upstream.calls.map(call => call.apiKey)).toEqual(['primary-api-key']);
    expect(JSON.stringify(upstream.calls)).not.toContain('Claude Code');
    expect(JSON.stringify(upstream.calls)).not.toContain('x-anthropic-billing-header');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
