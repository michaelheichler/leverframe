import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KeyringOperation, KeyringResult } from '../src/keyring-operations.js';
import { savePreferences } from '../src/config.js';
import * as requestPolicy from '../src/context/request-policy.js';
import { openEvidenceStore } from '../src/context/evidence-runtime.js';
import { reserveSummarySpend } from '../src/context/summary-spend.js';
import { isLeverframeSummaryMessage, type CompactionMessage } from '../src/context/request-compaction.js';
import * as paidSummaryEngine from '../src/context/paid-summary-engine.js';
import type { SummaryEngine } from '../src/context/summary-engine.js';
import { saveRegistry } from '../src/registry/io.js';
import { startProxyCatalog, type ProxyHandle, type ProxyRoute } from '../src/proxy.js';
import { sourceMessages } from './fixtures/context-summary-fixtures.js';

const memoryKeyring = vi.hoisted(() => ({ entries: new Map<string, string>() }));
const fakeSummaryState = vi.hoisted(() => ({ calls: [] as string[], engine: undefined as unknown }));

vi.mock('../src/keyring-operations.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/keyring-operations.js')>();
  return {
    ...actual,
    runIsolatedKeyringOperation: vi.fn(async (input: KeyringOperation): Promise<KeyringResult> => {
      const key = `${input.service}:${input.account}`;
      if (input.operation === 'read') return { ok: true, value: memoryKeyring.entries.get(key) ?? null };
      if (input.operation === 'write') {
        memoryKeyring.entries.set(key, input.value);
        return { ok: true, value: null };
      }
      return { ok: false, error: 'unexpected keyring operation' };
    }),
  };
});

vi.mock('../src/context/paid-summary-engine.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/context/paid-summary-engine.js')>();
  return {
    ...actual,
    configuredPaidSummaryEngine: vi.fn(() => fakeSummaryState.engine),
  };
});

type CapturedCall = { key: string | undefined; body: Record<string, unknown> };
type Fixture = {
  home: string;
  proxy: ProxyHandle;
  upstream: Awaited<ReturnType<typeof startMainUpstream>>;
  body: Record<string, unknown>;
  summaryCalls: string[];
};
const originalAppHome = process.env['LEVERFRAME_HOME'];
const originalAlpha = process.env['SUMMARY_PROXY_ALPHA'];
const originalBeta = process.env['SUMMARY_PROXY_BETA'];
const originalSummaryKey = process.env['LEVERFRAME_SUMMARY_API_KEY'];
let fixture: Fixture | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreEnvironment();
  memoryKeyring.entries.clear();
  await fixture?.proxy.close();
  await fixture?.upstream.close();
  if (fixture) rmSync(fixture.home, { recursive: true, force: true });
  fakeSummaryState.calls.length = 0;
  fakeSummaryState.engine = undefined;
  fixture = undefined;
});

function restoreEnvironment(): void {
  if (originalAppHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalAppHome;
  if (originalAlpha === undefined) delete process.env['SUMMARY_PROXY_ALPHA'];
  else process.env['SUMMARY_PROXY_ALPHA'] = originalAlpha;
  if (originalBeta === undefined) delete process.env['SUMMARY_PROXY_BETA'];
  else process.env['SUMMARY_PROXY_BETA'] = originalBeta;
  if (originalSummaryKey === undefined) delete process.env['LEVERFRAME_SUMMARY_API_KEY'];
  else process.env['LEVERFRAME_SUMMARY_API_KEY'] = originalSummaryKey;
}

function guardFetchToLoopback(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('Non-loopback fetch blocked by fixture');
    return realFetch(input, init);
  });
}

function saveFixtureSettings(): void {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:SUMMARY_PROXY_ALPHA', api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: 'env:SUMMARY_PROXY_ALPHA', enabled: true },
        { id: 'beta', authRef: 'env:SUMMARY_PROXY_BETA', enabled: true },
      ],
    }],
  });
  savePreferences({ summarySettings: {
    enabled: true, engineId: 'openai:summary-fixture', lifetimeLimitMicros: 100,
    pricing: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 1_000, provenance: 'localhost fixture rate card' },
  } });
}

function requestBody(): Record<string, unknown> {
  const messages = sourceMessages().slice(1);
  messages[3] = {
    ...messages[3], content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'old result '.repeat(2_000) }],
  };
  messages.splice(4, 0,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-middle', name: 'search', input: { query: 'middle result' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-middle', content: 'middle result '.repeat(2_000) }] },
  );
  return {
    model: 'anthropic-api__summary-fixture', max_tokens: 200,
    system: [{ type: 'text', text: 'Preserve the main request instruction.' }],
    messages, stream: false,
  };
}

function fakeEngine(summaryCalls: string[], invalidSynopsis = false): SummaryEngine {
  return {
    identity: 'injected-summary-fixture', billing: 'paid',
    summarize: async input => {
      summaryCalls.push(input.sourceText);
      return {
        synopsis: invalidSynopsis ? null : {
          version: 1, taskGoal: 'Keep the prior search result available.', userDecisions: [], constraints: [],
          verifiedFacts: input.sourceIds.map(sourceId => ({ text: 'Prior search result from the fixture.', sourceIds: [sourceId] })),
          files: [], toolOutcomes: [], unresolved: [], failedApproaches: [], nextActions: [], chronology: [],
        },
        sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 },
      };
    },
  };
}

function createRoute(port: number): ProxyRoute {
  return {
    aliasId: 'anthropic-api__summary-fixture', realModelId: 'summary-fixture-model',
    displayName: 'Summary fixture', upstreamUrl: `http://127.0.0.1:${port}`,
    apiKey: 'route-snapshot-key', modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
    providerId: 'anthropic-api', authType: 'api', contextWindow: 128_000,
  };
}

async function startMainUpstream(): Promise<{ calls: CapturedCall[]; port: number; close: () => Promise<void> }> {
  const calls: CapturedCall[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const key = request.headers['x-api-key'];
    calls.push({ key: Array.isArray(key) ? key[0] : key, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
    if (key === 'summary-alpha-key') {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'summary-proxy-response', type: 'message', role: 'assistant', model: 'summary-fixture-model',
      content: [{ type: 'text', text: 'alternate fixture success' }], stop_reason: 'end_turn',
      stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local summary proxy upstream did not bind');
  return {
    calls, port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function startFixture(invalidSynopsis = false): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-summary-proxy-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('SUMMARY_PROXY_ALPHA', 'summary-alpha-key');
  vi.stubEnv('SUMMARY_PROXY_BETA', 'summary-beta-key');
  vi.stubEnv('LEVERFRAME_SUMMARY_API_KEY', 'unused-fake-key');
  guardFetchToLoopback();
  memoryKeyring.entries.clear();
  saveFixtureSettings();
  const summaryCalls = fakeSummaryState.calls;
  fakeSummaryState.engine = fakeEngine(summaryCalls, invalidSynopsis);
  vi.spyOn(requestPolicy, 'applyRequestContextPolicy');
  const upstream = await startMainUpstream();
  const proxy = await startProxyCatalog([createRoute(upstream.port)], 'anthropic-api__summary-fixture');
  return { home, proxy, upstream, body: requestBody(), summaryCalls };
}

function sendProxyRequest(port: number, token: string, body: Record<string, unknown>): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload), 'X-Claude-Code-Session-Id': '11111111-1111-4111-8111-111111111111',
        Connection: 'close',
      },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function findSummary(body: Record<string, unknown>): CompactionMessage {
  const messages = body.messages as CompactionMessage[];
  const summary = messages.find(isLeverframeSummaryMessage);
  if (!summary) throw new Error('validated summary was not forwarded');
  return summary;
}

async function assertEvidenceIsRetrievable(summary: CompactionMessage): Promise<void> {
  const content = (summary.content as Array<{ text?: string }>).find(block => block.text?.startsWith('LEVERFRAME_SUMMARY_V1:'))?.text;
  const envelope = JSON.parse(content!.slice(content!.indexOf(':') + 1)) as { synopsis: { text: string } };
  const evidence = JSON.parse(envelope.synopsis.text) as { evidence: Array<{ reference: string }> };
  await expect((await openEvidenceStore()).get('11111111-1111-4111-8111-111111111111', evidence.evidence[0].reference)).resolves.toContain('old result ');
}

function assertSourceContext(body: Record<string, unknown>, original: Record<string, unknown>): void {
  const messages = body.messages as CompactionMessage[];
  const originalMessages = original.messages as CompactionMessage[];
  expect(body.system).toEqual(original.system);
  expect(messages).toContainEqual(originalMessages[0]);
  expect(messages).toContainEqual(originalMessages[1]);
  expect(messages).toContainEqual(originalMessages[4]);
  expect(messages).toContainEqual(originalMessages[5]);
  expect(JSON.stringify(messages)).toContain('opaque provider state');
  expect(JSON.stringify(messages)).toContain('The failed lookup error must stay visible.');
  expect(JSON.stringify(messages)).not.toContain('old result '.repeat(120));
}

it('applies saved summary opt-in once before quota failover and forwards the same safe summary', async () => {
  fixture = await startFixture();

  const status = await sendProxyRequest(fixture.proxy.port, fixture.proxy.token, fixture.body);

  expect(status).toBe(200);
  expect(fixture.upstream.calls.map(call => call.key)).toEqual(['summary-alpha-key', 'summary-beta-key']);
  expect(fixture.upstream.calls.map(call => call.body)).toEqual([fixture.upstream.calls[0].body, fixture.upstream.calls[0].body]);
  expect(vi.mocked(requestPolicy.applyRequestContextPolicy)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(paidSummaryEngine.configuredPaidSummaryEngine)).toHaveBeenCalledTimes(1);
  expect(fixture.summaryCalls).toHaveLength(1);
  expect(fixture.summaryCalls[0]).not.toContain('Keep this earlier user prose verbatim.');
  const firstBody = fixture.upstream.calls[0].body;
  const summary = findSummary(firstBody);
  expect(summary.role).toBe('user');
  expect(JSON.stringify(summary)).toContain('Prior search result from the fixture.');
  assertSourceContext(firstBody, fixture.body);
  await assertEvidenceIsRetrievable(summary);
});

it('reports actual paid usage when policy rejects malformed summary output', async () => {
  fixture = await startFixture(true);

  const result = await requestPolicy.applyRequestContextPolicy({
    request: fixture.body, sessionId: '11111111-1111-4111-8111-111111111111',
    routeIdentity: 'anthropic-api:summary-fixture-model', contextWindow: 128_000,
    signal: new AbortController().signal,
  });

  expect(result.request).toBe(fixture.body);
  expect(result.outcome).toBe('unchanged');
  expect(result.summaryUsage).toEqual({ inputTokens: 90, outputTokens: 30, costMicros: 1 });
  expect(result.summaryChargedMicros).toBe(1);
  expect(fixture.summaryCalls).toHaveLength(1);
  expect(reserveSummarySpend({ limitMicros: 100, maximumMicros: 99 })).toBeTruthy();
});
