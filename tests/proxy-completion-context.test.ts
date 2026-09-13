import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { streamMock, generateMock } = vi.hoisted(() => ({ streamMock: vi.fn(), generateMock: vi.fn() }));

vi.mock('../src/sdk-adapter.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sdk-adapter.js')>(),
  streamAnthropicResponse: streamMock,
  generateAnthropicResponse: generateMock,
}));

vi.mock('../src/provider-factory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-factory.js')>(),
  createLanguageModel: vi.fn(async () => ({})),
}));

import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

const route: ProxyRoute = {
  aliasId: 'leverframe:test:completion', realModelId: 'completion', displayName: 'Completion',
  upstreamUrl: '', apiKey: 'test-key', modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
  baseURL: 'http://127.0.0.1:1/v1', providerId: 'test-provider', contextWindow: 272_000,
};

describe('proxy completion context', () => {
  let appHome: string;

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'leverframe-completion-context-'));
    vi.stubEnv('LEVERFRAME_HOME', appHome);
    streamMock.mockReset().mockImplementation(async (...args: unknown[]) => {
      (args[3] as (chunk: string) => void)('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    generateMock.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'done' }], usage: {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(appHome, { recursive: true, force: true });
  });

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('passes only confirmed context with stream=%s and unconfirmed=%s', async (stream, unconfirmed) => {
    const proxy = await startProxyCatalog([{ ...route, contextWindowUnconfirmed: unconfirmed }], route.aliasId);
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${proxy.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: route.aliasId, messages: [{ role: 'user', content: 'hi' }], stream }),
      });
      await response.text();
      expect(response.status).toBe(200);
      const options = stream ? streamMock.mock.calls[0]?.[5] : generateMock.mock.calls[0]?.[3];
      expect(options.contextWindow).toBe(unconfirmed ? undefined : 272_000);
    } finally {
      await proxy.close();
    }
  });
});
