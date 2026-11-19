import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
import { refreshChatGptPlanCredential, runChatGptPlanOAuthFlow } from '../src/oauth/chatgpt-plan.js';
import { getAppHome } from '../src/paths.js';

const clientId = 'oaiapp_test';
const issuer = 'https://auth.openai.com';
const tokenEndpoint = issuer + '/api/accounts/oauth/token';
const directScope = 'chatgpt.tokens.use.direct';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });

beforeAll(() => {
  const home = resolve(process.env.HOME!);
  const appHome = resolve(getAppHome());
  expect(appHome).toBe(resolve(process.env.LEVERFRAME_TEST_HOME!));
  const hostFile = relative(home, join(appHome, 'chatgpt-plan-host-id'));
  expect(hostFile).toMatch(/^(?:leverframe[/\\])?chatgpt-plan-host-id$/);
});

function browserEmulator(callbackFields: Record<string, string> = {}) {
  let authorization: URL;
  let callbackRequest: Promise<number>;
  const openBrowser = (url: string) => {
    authorization = new URL(url);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get('state')!,
      code: 'authorization-code',
      client_id: clientId,
      ...callbackFields,
    }).toString();
    callbackRequest = fetch(callback).then(response => response.status);
  };
  return {
    openBrowser,
    get authorization() { return authorization; },
    get callbackRequest() { return callbackRequest; },
  };
}

function signedIdentity(nonce: string, claims: Record<string, string | number> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: clientId, exp: Math.floor(Date.now() / 1000) + 120, nonce, sub: 'account-subject',
    ...claims,
  })).toString('base64url');
  const data = header + '.' + payload;
  return data + '.' + sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url');
}

function mockAuthorization(browser: ReturnType<typeof browserEmulator>, claims?: Record<string, string | number>, scope = directScope) {
  return vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => Response.json({
      token_type: 'Bearer', access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, scope,
      id_token: signedIdentity(browser.authorization.searchParams.get('nonce')!, claims),
    }))
    .mockResolvedValueOnce(Response.json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key' }] }));
}

it('registers with OpenAI and binds the issued credential to the verified account and host', async () => {
  const browser = browserEmulator();
  const openAi = mockAuthorization(browser);

  const credential = await runChatGptPlanOAuthFlow({ openBrowser: browser.openBrowser, fetchImpl: openAi, timeoutMs: 2000 });

  expect(await browser.callbackRequest).toBe(200);
  expect(browser.authorization.origin + browser.authorization.pathname).toBe(issuer + '/api/accounts/authorize');
  const query = browser.authorization.searchParams;
  expect(Object.fromEntries(query)).toMatchObject({
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'Leverframe',
    response_type: 'code',
    resource: 'https://api.openai.com/v1',
    code_challenge_method: 'S256',
    ext_agent_host_id: expect.stringMatching(/^urn:uuid:[0-9a-f-]+$/),
    redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/),
  });
  expect(query.get('scope')!.split(' ')).toContain(directScope);
  expect(openAi.mock.calls).toEqual([
    [tokenEndpoint, expect.objectContaining({ method: 'POST', body: expect.any(URLSearchParams), redirect: 'error' })],
    [issuer + '/.well-known/jwks.json', expect.objectContaining({ signal: expect.any(AbortSignal), redirect: 'error' })],
  ]);
  const exchange = openAi.mock.calls[0]![1]!.body as URLSearchParams;
  expect(Object.fromEntries(exchange)).toEqual({
    grant_type: 'authorization_code', client_id: clientId, code: 'authorization-code',
    redirect_uri: query.get('redirect_uri'), resource: 'https://api.openai.com/v1', code_verifier: expect.any(String),
  });
  expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(query.get('code_challenge'));
  expect(credential).toMatchObject({
    type: 'oauth', access: 'access-token', refresh: 'refresh-token', accountId: clientId,
    providerData: { clientId, hostId: query.get('ext_agent_host_id'), subject: 'account-subject', scopes: [directScope] },
  });
});

it('refuses a callback with a mismatched state before exchanging its code', async () => {
  const browser = browserEmulator({ state: 'unrelated-attempt' });
  const openAi = vi.fn<typeof fetch>();

  await expect(runChatGptPlanOAuthFlow({ openBrowser: browser.openBrowser, fetchImpl: openAi, timeoutMs: 2000 }))
    .rejects.toThrow(/state did not match/i);

  expect(await browser.callbackRequest).toBe(400);
  expect(openAi).not.toHaveBeenCalled();
});

it.each<Record<string, string | number>>([
  { nonce: 'nonce-from-another-attempt' },
  { aud: 'oaiapp_another' },
  { iss: 'https://example.invalid' },
  { exp: 1 },
])('rejects a signed identity with invalid claims %j', async claims => {
  const browser = browserEmulator();
  const openAi = mockAuthorization(browser, claims);

  await expect(runChatGptPlanOAuthFlow({ openBrowser: browser.openBrowser, fetchImpl: openAi, timeoutMs: 2000 }))
    .rejects.toThrow(/invalid ChatGPT identity token/i);

  expect(await browser.callbackRequest).toBe(200);
  expect(openAi.mock.calls.map(([url]) => url)).toEqual([tokenEndpoint, issuer + '/.well-known/jwks.json']);
});

it('requires the ChatGPT plan scope in the token grant', async () => {
  const browser = browserEmulator();
  const openAi = mockAuthorization(browser, {}, 'openid profile');

  await expect(runChatGptPlanOAuthFlow({ openBrowser: browser.openBrowser, fetchImpl: openAi, timeoutMs: 2000 }))
    .rejects.toThrow(/did not grant ChatGPT plan permission/i);

  expect(await browser.callbackRequest).toBe(200);
  expect(openAi.mock.calls.map(([url]) => url)).toEqual([tokenEndpoint]);
});

it('refreshes using the issued client and keeps the registered account with rotating tokens', async () => {
  const providerData = {
    clientId, hostId: 'urn:uuid:123e4567-e89b-42d3-a456-426614174000', subject: 'account-subject', scopes: [directScope],
  };
  const openAi = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    token_type: 'Bearer', access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
  }));

  const refreshed = await refreshChatGptPlanCredential({
    type: 'oauth', accountId: clientId, access: 'old-access', refresh: 'old-refresh', expires: 0, providerData,
  }, openAi);

  expect(openAi.mock.calls).toEqual([[tokenEndpoint, expect.objectContaining({
    method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: 'old-refresh', resource: 'https://api.openai.com/v1',
    }),
    redirect: 'error',
  })]]);
  expect(refreshed).toMatchObject({ accountId: clientId, type: 'oauth', access: 'new-access', refresh: 'new-refresh', providerData });
  expect(refreshed.expires).toBeGreaterThan(Date.now());
});
