import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as http from 'node:http';
import type { ProxyRoute } from '../src/proxy.js';
import { decideHttpProxyRoute, type HttpProxyRouteInput } from '../src/http-proxy/routing-decision.js';
import { buildProxyRoutesById } from '../src/http-proxy/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function route(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    aliasId: 'claude-relay-test',
    realModelId: 'gpt-test',
    displayName: 'Test model',
    upstreamUrl: 'https://example.invalid/v1/chat/completions',
    apiKey: 'test-key',
    modelFormat: 'openai',
    providerId: 'openai',
    ...overrides,
  };
}

function baseInput(overrides: Partial<HttpProxyRouteInput> = {}): HttpProxyRouteInput {
  return {
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    rawBody: Buffer.from(JSON.stringify({ model: 'claude-relay-test' })),
    routesById: new Map(),
    hasAdapter: false,
    ...overrides,
  };
}

describe('decideHttpProxyRoute', () => {
  it('is raw for non-POST methods, even on the messages path', () => {
    const decision = decideHttpProxyRoute(baseInput({ method: 'GET' }));
    expect(decision).toEqual({ action: 'raw' });
  });

  it('is raw for POST requests outside /v1/messages and /v1/messages/count_tokens', () => {
    const decision = decideHttpProxyRoute(baseInput({ url: '/v1/models' }));
    expect(decision).toEqual({ action: 'raw' });
  });

  it('still dispatches /v1/messages/count_tokens but never logs or attaches a lifecycle for it', () => {
    const matched = route();
    const routesById = new Map([['claude-relay-test', matched]]);
    const inferenceLogPath = join(mkdtempSync(join(tmpdir(), 'leverframe-count-tokens-')), 'unused.jsonl');
    const decision = decideHttpProxyRoute(baseInput({
      url: '/v1/messages/count_tokens',
      routesById,
      hasAdapter: true,
      inferenceLogPath,
    }));
    expect(decision).toEqual({ action: 'translated', route: matched, lifecycle: undefined });
    expect(existsSync(inferenceLogPath)).toBe(false);
  });

  it('fails closed to passthrough when the model id matches no route', () => {
    const decision = decideHttpProxyRoute(baseInput({ hasAdapter: true }));
    expect(decision.action).toBe('passthrough-messages');
  });

  it('fails closed to passthrough when a route matches but no adapter is running', () => {
    const routesById = new Map([['claude-relay-test', route()]]);
    const decision = decideHttpProxyRoute(baseInput({ routesById, hasAdapter: false }));
    expect(decision.action).toBe('passthrough-messages');
  });

  it('fails closed to passthrough on an unparsable body, never touching a matching route id', () => {
    const routesById = new Map([['claude-relay-test', route()]]);
    const decision = decideHttpProxyRoute(baseInput({
      routesById,
      hasAdapter: true,
      rawBody: Buffer.from('not json'),
    }));
    expect(decision).toMatchObject({ action: 'passthrough-messages', modelId: 'unknown' });
  });

  it('routes to the adapter only when both a route matches and an adapter is running', () => {
    const matched = route();
    const routesById = new Map([['claude-relay-test', matched]]);
    const decision = decideHttpProxyRoute(baseInput({ routesById, hasAdapter: true }));
    expect(decision.action).toBe('translated');
    if (decision.action === 'translated') {
      expect(decision.route).toBe(matched);
    }
  });

  it('carries no lifecycle when inferenceLogPath is not configured', () => {
    const routesById = new Map([['claude-relay-test', route()]]);
    const decision = decideHttpProxyRoute(baseInput({ routesById, hasAdapter: true }));
    expect(decision.action).toBe('translated');
    if (decision.action === 'translated') {
      expect(decision.lifecycle).toBeUndefined();
    }
  });

  it('is exhaustive over its own action union', () => {
    const decision = decideHttpProxyRoute(baseInput({ method: 'GET' }));
    switch (decision.action) {
      case 'raw':
        expect(decision).toEqual({ action: 'raw' });
        break;
      case 'translated':
      case 'passthrough-messages':
        throw new Error('unreachable for this input');
      default: {
        const exhaustive: never = decision;
        throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
});

describe('decideHttpProxyRoute logging and privacy', () => {
  const testHome = mkdtempSync(join(tmpdir(), 'leverframe-routing-decision-'));

  function readEntries(path: string): Record<string, unknown>[] {
    return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  }

  it('logs route: passthrough and a stable requestId when no route matches', () => {
    const inferenceLogPath = join(testHome, 'passthrough.jsonl');
    const decision = decideHttpProxyRoute(baseInput({ hasAdapter: true, inferenceLogPath }));
    expect(decision.action).toBe('passthrough-messages');
    const [entry] = readEntries(inferenceLogPath);
    expect(entry).toMatchObject({ route: 'passthrough', provider: 'anthropic', modelId: 'claude-relay-test' });
    if (decision.action === 'passthrough-messages' && entry) {
      expect(entry['requestId']).toBe(decision.requestId);
    }
  });

  it('logs route: translated and the resolved provider when dispatching to the adapter', () => {
    const inferenceLogPath = join(testHome, 'translated.jsonl');
    const routesById = new Map([['claude-relay-test', route({ providerId: 'my-provider' })]]);
    decideHttpProxyRoute(baseInput({ routesById, hasAdapter: true, inferenceLogPath }));
    const [entry] = readEntries(inferenceLogPath);
    expect(entry).toMatchObject({ route: 'translated', provider: 'my-provider' });
  });

  it('never writes a request preview by default, even with an explicit conversation body', () => {
    delete process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
    const inferenceLogPath = join(testHome, 'no-preview.jsonl');
    const rawBody = Buffer.from(JSON.stringify({
      model: 'claude-relay-test',
      messages: [{ role: 'user', content: 'private tool output should never be logged' }],
    }));
    decideHttpProxyRoute(baseInput({ hasAdapter: true, inferenceLogPath, rawBody }));
    expect(readFileSync(inferenceLogPath, 'utf8')).not.toContain('private tool output');
  });

  it('extracts the Claude session id from the header, redacting it from the diagnostic body', () => {
    const webSocketDiagnosticsLogPath = join(testHome, 'diagnostics.jsonl');
    const headers: http.IncomingHttpHeaders = { 'x-claude-code-session-id': SESSION_ID };
    decideHttpProxyRoute(baseInput({ headers, hasAdapter: false, webSocketDiagnosticsLogPath }));
    const [entry] = readEntries(webSocketDiagnosticsLogPath);
    expect(entry).toMatchObject({ claudeSessionId: SESSION_ID, route: 'passthrough' });
  });

  it('ignores a malformed session id header rather than logging garbage', () => {
    const webSocketDiagnosticsLogPath = join(testHome, 'diagnostics-invalid.jsonl');
    const headers: http.IncomingHttpHeaders = { 'x-claude-code-session-id': 'not-a-uuid' };
    decideHttpProxyRoute(baseInput({ headers, hasAdapter: false, webSocketDiagnosticsLogPath }));
    const [entry] = readEntries(webSocketDiagnosticsLogPath);
    expect(entry).not.toHaveProperty('claudeSessionId');
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });
});

describe('decideHttpProxyRoute lookupRoute parity', () => {
  it('resolves [1m] context suffix variants to the canonical route', () => {
    const matched = route({ aliasId: 'leverframe:openai-oauth:gpt-5.6-luna', realModelId: 'gpt-5.6-luna' });
    const routesById = buildProxyRoutesById([matched]);
    const decision = decideHttpProxyRoute(baseInput({
      routesById,
      hasAdapter: true,
      rawBody: Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna[1m]' })),
    }));
    expect(decision.action).toBe('translated');
    if (decision.action === 'translated') expect(decision.route).toBe(matched);
  });

  it('resolves models/ prefix variants to the canonical route', () => {
    const matched = route({ aliasId: 'leverframe:google:gemini-2.5', realModelId: 'gemini-2.5' });
    const routesById = buildProxyRoutesById([matched]);
    const decision = decideHttpProxyRoute(baseInput({
      routesById,
      hasAdapter: true,
      rawBody: Buffer.from(JSON.stringify({ model: 'models/gemini-2.5' })),
    }));
    expect(decision.action).toBe('translated');
    if (decision.action === 'translated') expect(decision.route).toBe(matched);
  });
});

describe('buildProxyRoutesById (bare Agent-tool model ids)', () => {
  it('resolves a bare realModelId sent by an Agent-tool child session to its route', () => {
    const matched = route({ aliasId: 'leverframe:openai-oauth:gpt-5.6-luna', realModelId: 'gpt-5.6-luna' });
    const routesById = buildProxyRoutesById([matched]);
    const decision = decideHttpProxyRoute(baseInput({
      routesById,
      hasAdapter: true,
      rawBody: Buffer.from(JSON.stringify({ model: 'gpt-5.6-luna' })),
    }));
    expect(decision.action).toBe('translated');
    if (decision.action === 'translated') {
      expect(decision.route).toBe(matched);
    }
  });

  it('never lets a bare realModelId override an existing canonical alias or saved alias name', () => {
    const canonical = route({ aliasId: 'shared-id', realModelId: 'gpt-primary', displayName: 'Canonical' });
    const collidingByRealModelId = route({
      aliasId: 'leverframe:openai-oauth:collider',
      realModelId: 'shared-id',
      displayName: 'Collider (real id collides with canonical alias)',
    });
    const routesById = buildProxyRoutesById([canonical, collidingByRealModelId]);
    expect(routesById.get('shared-id')).toBe(canonical);

    const savedAliasName = route({ aliasId: 'leverframe:openai-oauth:second', realModelId: 'aliased-name' });
    const collidingByRealModelId2 = route({
      aliasId: 'leverframe:openai-oauth:collider-2',
      realModelId: 'aliased-name',
    });
    const routesByIdWithAlias = buildProxyRoutesById(
      [savedAliasName, collidingByRealModelId2],
      [{ name: 'aliased-name', routeId: 'leverframe:openai-oauth:second', displayName: 'Aliased' }],
    );
    expect(routesByIdWithAlias.get('aliased-name')).toBe(savedAliasName);
  });

  it('still fails closed to passthrough for a truly unknown model id', () => {
    const matched = route({ aliasId: 'leverframe:openai-oauth:gpt-5.6-luna', realModelId: 'gpt-5.6-luna' });
    const routesById = buildProxyRoutesById([matched]);
    const decision = decideHttpProxyRoute(baseInput({
      routesById,
      hasAdapter: true,
      rawBody: Buffer.from(JSON.stringify({ model: 'totally-unknown-model' })),
    }));
    expect(decision.action).toBe('passthrough-messages');
  });
});
