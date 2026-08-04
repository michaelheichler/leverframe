// Exercises the proxy replay boundary with mocked SDK transport outcomes while retaining real lifecycle and checkpoint persistence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listExecutions } from '../src/checkpoint-store.js';
import { loadCheckpoint } from '../src/execution-checkpoint.js';

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock('../src/sdk-adapter.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sdk-adapter.js')>(),
  streamAnthropicResponse: streamMock,
}));

vi.mock('../src/provider-factory.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-factory.js')>(),
  createLanguageModel: vi.fn(async () => ({})),
}));

vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/url-security.js')>(),
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

function postToProxy(port: number, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'leverframe:test:auto-replay',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const route: ProxyRoute = {
  aliasId: 'leverframe:test:auto-replay',
  realModelId: 'auto-replay',
  displayName: 'Auto Replay',
  upstreamUrl: '',
  apiKey: '',
  modelFormat: 'openai',
  npm: '@ai-sdk/openai-compatible',
  baseURL: 'http://127.0.0.1:1/v1',
  providerId: 'test-provider',
};

function resetFailure(): Error {
  return Object.assign(new Error('socket reset before response'), { code: 'ECONNRESET' });
}

function serverFailure(): Error {
  return Object.assign(new Error('service unavailable'), { statusCode: 503 });
}

describe('SDK stream auto-replay', () => {
  let home: string;
  const previousHome = process.env['LEVERFRAME_HOME'];
  const previousMaxRetries = process.env['LEVERFRAME_AUTO_REPLAY_MAX_RETRIES'];
  const previousHeartbeat = process.env['LEVERFRAME_SSE_HEARTBEAT_MS'];

  const restoreHeartbeat = () => {
    if (previousHeartbeat === undefined) delete process.env['LEVERFRAME_SSE_HEARTBEAT_MS'];
    else process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = previousHeartbeat;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-auto-replay-'));
    process.env['LEVERFRAME_HOME'] = home;
    streamMock.mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previousHome;
    if (previousMaxRetries === undefined) delete process.env['LEVERFRAME_AUTO_REPLAY_MAX_RETRIES'];
    else process.env['LEVERFRAME_AUTO_REPLAY_MAX_RETRIES'] = previousMaxRetries;
    restoreHeartbeat();
    rmSync(home, { recursive: true, force: true });
  });

  it('replays a transient pre-output failure and persists the retry count', async () => {
    streamMock
      .mockRejectedValueOnce(resetFailure())
      .mockImplementationOnce(async (...args: unknown[]) => {
        const write = args[3] as (chunk: string) => void;
        write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    const proxy = await startProxyCatalog([route], route.aliasId, false);

    try {
      const response = await postToProxy(proxy.port, proxy.token);
      expect(response.status).toBe(200);
      expect(streamMock).toHaveBeenCalledTimes(2);
      const [execution] = listExecutions();
      expect(execution).toBeDefined();
      if (!execution) throw new Error('execution checkpoint not found');
      const checkpoint = loadCheckpoint(execution.scopeHash, execution.executionId);
      expect(checkpoint.value?.retryCount).toBe(1);
    } finally {
      proxy.close();
    }
  });

  it('keeps replay available after an idle heartbeat', async () => {
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '10';
    streamMock
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        throw resetFailure();
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const write = args[3] as (chunk: string) => void;
        write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    const proxy = await startProxyCatalog([route], route.aliasId, false);

    try {
      const response = await postToProxy(proxy.port, proxy.token);
      expect(response.status).toBe(200);
      const pingFrame = response.body.split('\n\n').find(frame => frame.startsWith('event: ping\n'));
      expect(pingFrame).toBeDefined();
      const pingDataLine = pingFrame?.split('\n').find(line => line.startsWith('data: '));
      expect(pingDataLine).toBe('data: {"type":"ping"}');
      if (!pingDataLine) throw new Error('heartbeat data frame missing');
      expect(JSON.parse(pingDataLine.slice('data: '.length))).toEqual({ type: 'ping' });
      expect(response.body).toContain('event: message_stop');
      expect(streamMock).toHaveBeenCalledTimes(2);
    } finally {
      proxy.close();
    }
  });

  it('refuses replay after any stream output reached the client', async () => {

    streamMock.mockImplementation(async (...args: unknown[]) => {
      const write = args[3] as (chunk: string) => void;
      write('event: message_start\ndata: {"type":"message_start"}\n\n');
      throw resetFailure();
    });
    const proxy = await startProxyCatalog([route], route.aliasId, false);

    try {
      const response = await postToProxy(proxy.port, proxy.token);
      expect(response.status).toBe(200);
      expect(response.body).toContain('event: error');
      expect(streamMock).toHaveBeenCalledTimes(1);
    } finally {
      proxy.close();
    }
  });

  it('honors the configured replay cap', async () => {
    process.env['LEVERFRAME_AUTO_REPLAY_MAX_RETRIES'] = '1';
    streamMock.mockRejectedValue(serverFailure());
    const proxy = await startProxyCatalog([route], route.aliasId, false);

    try {
      const response = await postToProxy(proxy.port, proxy.token);
      expect(response.status).toBe(503);
      expect(streamMock).toHaveBeenCalledTimes(2);
    } finally {
      proxy.close();
    }
  });
});
