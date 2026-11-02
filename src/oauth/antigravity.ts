import { generateOAuthState, generatePkce } from './pkce.js';
import { tokensToStoredCredential, type OAuthTokenResponse, type StoredOAuthCredential } from './types.js';
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_SCOPES } from './antigravity-registration.js';
import { receiveAntigravityCode } from './antigravity-callback.js';
import { requestGoogleJson } from '../antigravity/http.js';
import { AntigravityError } from '../antigravity/types.js';
import { discoverAntigravityProject } from '../antigravity/discovery.js';
import { assertAntigravityBillingAllowed, clearAntigravityBillingLatch } from '../antigravity/billing-policy.js';

async function reviewBillingPolicy(accountId: string, confirm?: (accountId: string) => Promise<boolean>): Promise<void> {
  try {
    assertAntigravityBillingAllowed(accountId);
  } catch (error) {
    if (!confirm || !await confirm(accountId)) throw error;
    clearAntigravityBillingLatch(accountId);
  }
}

async function exchangeTokens(fields: Record<string, string>, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<OAuthTokenResponse> {
  const body = await requestGoogleJson('https://oauth2.googleapis.com/token', {
    method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET, ...fields }),
  }, fetchImpl);
  if (typeof body.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(body.access_token)
    || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0
    || (body.refresh_token !== undefined && typeof body.refresh_token !== 'string')) {
    throw new AntigravityError('Antigravity returned invalid OAuth credentials.', 401);
  }
  return body as unknown as OAuthTokenResponse;
}

export async function refreshAntigravityAccessToken(refreshToken: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<OAuthTokenResponse> {
  if (!refreshToken) throw new AntigravityError('Antigravity requires a saved refresh credential.', 401);
  return exchangeTokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, signal, fetchImpl);
}

export async function runAntigravityOAuthFlow(options: {
  signal?: AbortSignal;
  openBrowser: (url: string) => void;
  fetchImpl?: typeof fetch;
  callbackPort?: number;
  timeoutMs?: number;
  confirmBillingRecovery?: (accountId: string) => Promise<boolean>;
}): Promise<StoredOAuthCredential> {
  const pkce = await generatePkce();
  const state = generateOAuthState();
  const { code, redirectUri } = await receiveAntigravityCode({
    state, port: options.callbackPort ?? 51121, signal: options.signal, timeoutMs: options.timeoutMs ?? 300_000,
    openAuthorization: redirect => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID, response_type: 'code', redirect_uri: redirect,
        scope: ANTIGRAVITY_SCOPES.join(' '), state, code_challenge: pkce.challenge,
        code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
      }).toString();
      options.openBrowser(url.href);
    },
  });
  const tokens = await exchangeTokens({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pkce.verifier,
  }, options.signal, options.fetchImpl);
  if (!tokens.refresh_token) throw new AntigravityError('Antigravity did not grant offline access. Sign in again.', 401);
  const info = await requestGoogleJson('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    signal: options.signal, headers: { authorization: `Bearer ${tokens.access_token}` },
  }, options.fetchImpl);
  if (typeof info.id !== 'string' || !info.id) throw new AntigravityError('Antigravity account identity is missing.', 401);
  await reviewBillingPolicy(info.id, options.confirmBillingRecovery);
  const projectId = await discoverAntigravityProject(tokens.access_token, options.signal, options.fetchImpl, info.id);
  return tokensToStoredCredential(tokens, undefined, info.id, { projectId });
}
