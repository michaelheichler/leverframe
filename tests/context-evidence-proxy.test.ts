import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KeyringOperation, KeyringResult } from '../src/keyring-operations.js';
import { runIsolatedKeyringOperation } from '../src/keyring-operations.js';
import { openEvidenceStore } from '../src/context/evidence-runtime.js';
import * as requestPolicy from '../src/context/request-policy.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { TRUSTED_METADATA_KEYRING_ACCOUNT, TRUSTED_METADATA_KEYRING_SERVICE } from '../src/context/workspace-digest-key.js';

const memoryKeyring = vi.hoisted(() => ({ entries: new Map<string, string>() }));

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

type ResultMessage = { role: string; content: string | Record<string, unknown>[] };
type DuplicateRequest = { model: string; max_tokens: number; system: { type: string; text: string }[]; messages: ResultMessage[]; stream: false };
const sessionId = '11111111-1111-4111-8111-111111111111';

it('reduces repeated tool output before a fake upstream receives the request', async () => {
  const workspace = createWorkspace();
  const received: Record<string, unknown>[] = [];
  const upstream = await startUpstream(received);
  const route = proxyRoute(upstream.port);
  const proxy = await startProxyCatalog([route], route.aliasId, false);
  const policy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');
  const original = duplicateRequest(route.aliasId);

  try {
    const response = await sendRequest(proxy.port, proxy.token, original);
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(policy).toHaveBeenCalledTimes(1);
    await assertForwardedEvidence(received[0]!, original);
    expect(vi.mocked(runIsolatedKeyringOperation).mock.calls.map(([input]) => input)).toEqual([
      { operation: 'read', service: TRUSTED_METADATA_KEYRING_SERVICE, account: TRUSTED_METADATA_KEYRING_ACCOUNT },
      { operation: 'write', service: TRUSTED_METADATA_KEYRING_SERVICE, account: TRUSTED_METADATA_KEYRING_ACCOUNT, value: expect.any(String) },
      { operation: 'read', service: TRUSTED_METADATA_KEYRING_SERVICE, account: TRUSTED_METADATA_KEYRING_ACCOUNT },
      { operation: 'read', service: TRUSTED_METADATA_KEYRING_SERVICE, account: TRUSTED_METADATA_KEYRING_ACCOUNT },
    ]);
  } finally {
    vi.restoreAllMocks();
    memoryKeyring.entries.clear();
    await proxy.close();
    await upstream.close();
    workspace.close();
  }
});

async function assertForwardedEvidence(received: Record<string, unknown>, original: DuplicateRequest) {
  const messages = received.messages as ResultMessage[];
  const result = messages[4]?.content as Record<string, unknown>[];
  const reference = String(result[0]?.content).match(/'([^']+)'$/m)?.[1];
  const reduced = { ...original, model: 'fixture-model' };
  expect(messages).toHaveLength(original.messages.length);
  expect(messages.slice(1, 4)).toEqual(original.messages.slice(1, 4));
  expect(reference).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(received))).toBeLessThan(Buffer.byteLength(JSON.stringify(reduced)));
  await expect((await openEvidenceStore()).get(sessionId, reference!)).resolves.toBe('stable tool response '.repeat(180));
}

function duplicateRequest(model: string): DuplicateRequest {
  const output = 'stable tool response '.repeat(180);
  return {
    model, max_tokens: 321, system: [{ type: 'text', text: 'Retain the complete source context.' }], stream: false,
    messages: [
      { role: 'user', content: 'Repeat this lookup.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'first-call', name: 'lookup', input: { record: 'same' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first-call', content: output }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'second-call', name: 'lookup', input: { record: 'same' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'second-call', content: output }] },
    ],
  };
}

function proxyRoute(upstreamPort: number): ProxyRoute {
  return {
    aliasId: 'fixture-alias', realModelId: 'fixture-model', displayName: 'Fixture route',
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'fixture-upstream-key',
    modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', providerId: 'fixture-provider',
    authType: 'api', contextWindow: 128_000,
  };
}

function createWorkspace() {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-evidence-proxy-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  memoryKeyring.entries.clear();
  vi.mocked(runIsolatedKeyringOperation).mockClear();
  return { close: () => rmSync(home, { recursive: true, force: true }) };
}

async function startUpstream(received: Record<string, unknown>[]) {
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'fixture-response', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [{ type: 'text', text: 'response' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 },
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Local evidence upstream failed to bind');
  return {
    port: address.port,
    close: async () => {
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

async function sendRequest(port: number, token: string, body: DuplicateRequest) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Claude-Code-Session-Id': sessionId,
    },
    body: JSON.stringify(body),
  });
}
