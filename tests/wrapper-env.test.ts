import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeWrapperEnv, PROXY_AUTH_USER } from '../src/wrapper-env.js';
import {
  readLiveServerRuntimeState,
  registerServerRuntimeState,
  type ServerRuntimeState,
} from '../src/server-runtime.js';

const baseEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  ANTHROPIC_BASE_URL: 'https://corp.example/anthropic',
  HTTPS_PROXY: 'http://corp-proxy:8080',
  https_proxy: 'http://corp-proxy:8080',
  HOME: '/Users/someone',
};

describe('computeWrapperEnv', () => {
  it('proxy-mode server: injects proxy vars + CA and removes ANTHROPIC_BASE_URL', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/home/u/.leverframe/http-proxy/leverframe-ca.pem',
      token: 'proxy-secret-123',
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
    const expectedUrl = `http://${PROXY_AUTH_USER}:proxy-secret-123@127.0.0.1:17645`;
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[name]).toBe(expectedUrl);
    }
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/home/u/.leverframe/http-proxy/leverframe-ca.pem');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('proxy-mode server without token emits a credential-less URL (legacy upgrade)', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/tmp/ca.pem',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv(baseEnv, state);
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:17645');
  });

  it('endpoint-mode server: sets ANTHROPIC_API_KEY from the discovery token', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 4242,
      pid: process.pid,
      token: 'endpoint-bearer-token',
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4242/anthropic');
    expect(env['ANTHROPIC_API_KEY']).toBe('endpoint-bearer-token');
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      expect(env[name]).toBeUndefined();
    }
  });

  it('endpoint-mode server without a token leaves ANTHROPIC_API_KEY unset (legacy upgrade)', () => {
    const state: ServerRuntimeState = {
      mode: 'endpoint',
      port: 4242,
      pid: process.pid,
      startedAt: '2026-07-20T00:00:00.000Z',
    };

    const env = computeWrapperEnv(baseEnv, state);

    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:4242/anthropic');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('proxy-mode token is percent-encoded into the URL userinfo', () => {
    const state: ServerRuntimeState = {
      mode: 'proxy',
      port: 17645,
      pid: process.pid,
      caPath: '/tmp/ca.pem',
      token: 'a/b+c=d',
      startedAt: '2026-07-20T00:00:00.000Z',
    };
    const env = computeWrapperEnv(baseEnv, state);
    expect(env['HTTPS_PROXY']).toBe(`http://${PROXY_AUTH_USER}:a%2Fb%2Bc%3Dd@127.0.0.1:17645`);
  });

  it('no live server: returns the env untouched without mutating the input', () => {
    const env = computeWrapperEnv(baseEnv, null);

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
  });

  it('stale-pid server state resolves to null and leaves the env untouched', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'leverframe-wrapper-test-'));
    try {
      const homeEnv = { LEVERFRAME_HOME: join(tempHome, 'app-home') };
      registerServerRuntimeState({
        mode: 'proxy',
        port: 17645,
        pid: 999999,
        caPath: '/tmp/ca.pem',
        startedAt: '2026-07-20T00:00:00.000Z',
      }, homeEnv, { isAlive: () => true });

      const state = readLiveServerRuntimeState(homeEnv, { isAlive: () => false });
      const env = computeWrapperEnv(baseEnv, state);

      expect(state).toBeNull();
      expect(env).toEqual(baseEnv);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('computeWrapperEnv proxy-mode env normalization', () => {
  const proxyState: ServerRuntimeState = {
    mode: 'proxy',
    port: 17645,
    pid: process.pid,
    caPath: '/tmp/ca.pem',
    token: 'tok',
    startedAt: '2026-07-20T00:00:00.000Z',
  };

  it('strips NO_PROXY entries that would bypass api.anthropic.com', () => {
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'api.anthropic.com,example.com,*.anthropic.com',
    }, proxyState);
    expect(env['NO_PROXY']).toBe('example.com');
    expect(env['no_proxy']).toBe('example.com');
  });

  it('preserves a wildcard-free NO_PROXY', () => {
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'localhost,127.0.0.1,example.com',
    }, proxyState);
    expect(env['NO_PROXY']).toBe('localhost,127.0.0.1,example.com');
  });

  it('deletes NO_PROXY entirely when every entry bypassed api.anthropic.com', () => {
    const env = computeWrapperEnv({
      ...baseEnv,
      NO_PROXY: 'api.anthropic.com,*.anthropic.com',
    }, proxyState);
    expect(env['NO_PROXY']).toBeUndefined();
    expect(env['no_proxy']).toBeUndefined();
  });

  it('strips conflicting Vertex/Bedrock/Foundry env vars', () => {
    const env = computeWrapperEnv({
      ...baseEnv,
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
      ANTHROPIC_BASE_URL: 'https://stale.example',
    }, proxyState);
    expect(env['CLAUDE_CODE_USE_VERTEX']).toBeUndefined();
    expect(env['ANTHROPIC_VERTEX_PROJECT_ID']).toBeUndefined();
    expect(env['ANTHROPIC_BEDROCK_BASE_URL']).toBeUndefined();
    expect(env['ANTHROPIC_FOUNDRY_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_BASE_URL']).toBeUndefined();
  });

  it('preserves the child Anthropic auth + model env vars', () => {
    const env = computeWrapperEnv({
      ...baseEnv,
      ANTHROPIC_API_KEY: 'sk-ant-child',
      ANTHROPIC_AUTH_TOKEN: 'sk-auth-child',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    }, proxyState);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-child');
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-auth-child');
    expect(env['ANTHROPIC_MODEL']).toBe('claude-sonnet-4-6');
  });

  it('keeps the proxy-token userinfo percent-encoded in HTTPS_PROXY', () => {
    const env = computeWrapperEnv(baseEnv, { ...proxyState, token: 'a/b+c=d' });
    expect(env['HTTPS_PROXY']).toBe(`http://${PROXY_AUTH_USER}:a%2Fb%2Bc%3Dd@127.0.0.1:17645`);
  });
});
