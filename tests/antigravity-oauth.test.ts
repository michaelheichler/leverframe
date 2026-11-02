import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  refreshAntigravityAccessToken,
  runAntigravityOAuthFlow,
} from '../src/oauth/antigravity.js';
import { recordAntigravityCreditConsumption } from '../src/antigravity/billing-policy.js';

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function idToken(subject: string): string {
  const claims = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url');
  return `header.${claims}.signature`;
}

function sendBrowserCallback(authorizationUrl: string, fields: { code?: string; state?: string; error?: string }): void {
  const authUrl = new URL(authorizationUrl);
  const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
  callback.pathname = '/oauth-callback';
  callback.searchParams.set('state', fields.state ?? authUrl.searchParams.get('state')!);
  if (fields.code) callback.searchParams.set('code', fields.code);
  if (fields.error) callback.searchParams.set('error', fields.error);
  void fetch(callback).catch(() => {});
}

afterEach(() => vi.unstubAllEnvs());

it('returns stored identity and project after browser consent', async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/token') return jsonResponse(200, {
      access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 3600, id_token: idToken('account-a'),
    });
    if (url.pathname === '/oauth2/v1/userinfo') return jsonResponse(200, { id: 'account-a', email: 'a@example.test' });
    if (url.pathname.endsWith(':loadCodeAssist')) return jsonResponse(200, { cloudaicompanionProject: 'project-a' });
    throw new Error(`Unexpected external request ${url.pathname}, ${init?.method ?? 'GET'}`);
  });
  const credential = await runAntigravityOAuthFlow({
    callbackPort: 0, timeoutMs: 2_000, fetchImpl,
    openBrowser: url => sendBrowserCallback(url, { code: 'authorization-code' }),
  });

  expect(credential).toMatchObject({
    type: 'oauth', access: 'access-a', refresh: 'refresh-a', accountId: 'account-a',
    providerData: { projectId: 'project-a' },
  });
  expect(credential.expires).toBeGreaterThan(Date.now());
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

describe('Antigravity browser callback failures', () => {
  it('rejects a callback whose state does not match the login', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await expect(runAntigravityOAuthFlow({
      callbackPort: 0, timeoutMs: 2_000, fetchImpl,
      openBrowser: url => sendBrowserCallback(url, { code: 'authorization-code', state: 'wrong-state' }),
    })).rejects.toThrow(/state|authorization/i);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not exchange a token when the user denies consent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await expect(runAntigravityOAuthFlow({
      callbackPort: 0, timeoutMs: 2_000, fetchImpl,
      openBrowser: url => sendBrowserCallback(url, { error: 'access_denied' }),
    })).rejects.toThrow(/denied|cancel/i);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Antigravity browser login cancellation', () => {
  it('stops login when the caller cancels after opening the browser', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await expect(runAntigravityOAuthFlow({
      callbackPort: 0, timeoutMs: 2_000, signal: controller.signal, fetchImpl,
      openBrowser: () => controller.abort(new Error('cancelled')),
    })).rejects.toThrow(/cancel|abort/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops waiting when the browser does not return before the deadline', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await expect(runAntigravityOAuthFlow({
      callbackPort: 0, timeoutMs: 30, fetchImpl, openBrowser: () => {},
    })).rejects.toThrow(/timed out|expired/i);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it('reports a conflict when another process owns the callback port', async () => {
  const occupiedPort = createServer();
  await new Promise<void>(resolve => occupiedPort.listen(0, '127.0.0.1', resolve));
  const address = occupiedPort.address();
  const fetchImpl = vi.fn(async () => jsonResponse(200, {}));

  await expect(runAntigravityOAuthFlow({
    callbackPort: typeof address === 'object' && address ? address.port : 0,
    timeoutMs: 2_000,
    fetchImpl,
    openBrowser: () => {},
  })).rejects.toThrow(/port|callback|listen/i);

  await new Promise<void>(resolve => occupiedPort.close(() => resolve()));
  expect(fetchImpl).not.toHaveBeenCalled();
});

describe('Antigravity token refresh', () => {
  it('exchanges the stored refresh token for rotated credentials', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.hostname).toBe('oauth2.googleapis.com');
      expect(init?.method).toBe('POST');
      return jsonResponse(200, { access_token: 'access-b', refresh_token: 'refresh-b', expires_in: 1800 });
    });

    const tokens = await refreshAntigravityAccessToken('refresh-a', undefined, fetchImpl);

    expect(tokens).toMatchObject({ access_token: 'access-b', refresh_token: 'refresh-b', expires_in: 1800 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects revoked refresh credentials without exposing the response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('private provider detail', { status: 400 }));

    await expect(refreshAntigravityAccessToken('revoked-token', undefined, fetchImpl))
      .rejects.not.toThrow('private provider detail');
  });
});

describe('Antigravity OAuth billing recovery', () => {
  it('requires explicit review before clearing prior account credit consumption', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-oauth-recovery-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      recordAntigravityCreditConsumption('account-a', {
        consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1' }],
      });
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/token') return jsonResponse(200, {
          access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 3600, id_token: idToken('account-a'),
        });
        if (url.pathname === '/oauth2/v1/userinfo') return jsonResponse(200, { id: 'account-a' });
        throw new Error(`Unexpected external request ${url.pathname}, ${init?.method ?? 'GET'}`);
      });

      await expect(runAntigravityOAuthFlow({
        callbackPort: 0, timeoutMs: 2_000, fetchImpl,
        openBrowser: url => sendBrowserCallback(url, { code: 'authorization-code' }),
      })).rejects.toMatchObject({ statusCode: 409 });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('continues login after the user explicitly reviews and clears the account latch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-oauth-recovery-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      recordAntigravityCreditConsumption('account-a', {
        consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1' }],
      });
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/token') return jsonResponse(200, {
          access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 3600, id_token: idToken('account-a'),
        });
        if (url.pathname === '/oauth2/v1/userinfo') return jsonResponse(200, { id: 'account-a' });
        if (url.pathname.endsWith(':loadCodeAssist')) return jsonResponse(200, { cloudaicompanionProject: 'project-a' });
        throw new Error(`Unexpected external request ${url.pathname}, ${init?.method ?? 'GET'}`);
      });
      const confirmBillingRecovery = vi.fn(async (accountId: string) => accountId === 'account-a');

      const credential = await runAntigravityOAuthFlow({
        callbackPort: 0, timeoutMs: 2_000, fetchImpl, confirmBillingRecovery,
        openBrowser: url => sendBrowserCallback(url, { code: 'authorization-code' }),
      } as Parameters<typeof runAntigravityOAuthFlow>[0]);

      expect(credential).toMatchObject({ accountId: 'account-a', providerData: { projectId: 'project-a' } });
      expect(confirmBillingRecovery).toHaveBeenCalledTimes(1);
      expect(confirmBillingRecovery).toHaveBeenCalledWith('account-a');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
