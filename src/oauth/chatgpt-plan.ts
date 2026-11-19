import { OPENAI_CHATGPT_PLAN_BASE_URL } from '../constants.js';
import { receiveChatGptPlanCallback } from './chatgpt-plan-callback.js';
import { CHATGPT_PLAN_HOST_ID, CHATGPT_PLAN_ISSUER, chatGptPlanHostId, verifyChatGptPlanIdentity } from './chatgpt-plan-identity.js';
import { withAbortTimeout } from './fetch-timeout.js';
import { generateOAuthState, generatePkce } from './pkce.js';
import { parseStoredOAuthCredential, tokensToStoredCredential, type StoredOAuthCredential } from './types.js';

const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;

export function readChatGptPlanRegistration(data: Record<string, unknown> | undefined) {
  const { clientId, hostId, subject } = data ?? {};
  if (typeof clientId !== 'string' || !/^oaiapp_[A-Za-z0-9_-]{1,240}$/.test(clientId)
    || typeof hostId !== 'string' || !CHATGPT_PLAN_HOST_ID.test(hostId) || typeof subject !== 'string' || !subject) {
    throw new Error('ChatGPT plan registration is missing or invalid. Sign in again.');
  }
  return { clientId, hostId, subject };
}

function scopesFromGrant(scope: unknown): string[] {
  const scopes = typeof scope === 'string' ? scope.trim().split(/\s+/) : [];
  if (!scopes.includes(DIRECT_SCOPE)) throw new Error('OpenAI did not grant ChatGPT plan permission.');
  return scopes;
}

function isPlanAccessToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && !value.startsWith('sk-');
}

export function parseChatGptPlanCredential(raw: string | null): StoredOAuthCredential | null {
  const credential = parseStoredOAuthCredential(raw);
  if (!credential || !isPlanAccessToken(credential.access) || !credential.refresh || !Number.isFinite(credential.expires)) return null;
  try {
    const registration = readChatGptPlanRegistration(credential.providerData);
    const scopes = credential.providerData?.scopes;
    return credential.accountId === registration.clientId && Array.isArray(scopes) && scopes.includes(DIRECT_SCOPE) ? credential : null;
  } catch {
    return null;
  }
}

async function requestPlanTokens(fields: Record<string, string>, fetchImpl: typeof fetch, signal?: AbortSignal) {
  return withAbortTimeout(async timeout => {
    const response = await fetchImpl(CHATGPT_PLAN_ISSUER + '/api/accounts/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, resource: OPENAI_CHATGPT_PLAN_BASE_URL }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`ChatGPT plan authorization failed (HTTP ${response.status}).`);
    const { access_token, refresh_token, expires_in, id_token, scope, token_type } = await response.json() as Record<string, unknown>;
    if (!isPlanAccessToken(access_token)
      || typeof refresh_token !== 'string' || !refresh_token
      || typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in <= 0
      || typeof token_type !== 'string' || token_type.toLowerCase() !== 'bearer') {
      throw new Error('OpenAI returned invalid ChatGPT plan credentials.');
    }
    return { access_token, refresh_token, expires_in, id_token, scope };
  }, 'ChatGPT plan token request timed out.');
}

export async function runChatGptPlanOAuthFlow(options: {
  openBrowser: (url: string) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  existing?: Record<string, unknown>;
}): Promise<StoredOAuthCredential> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  signal.throwIfAborted();
  const existing = options.existing ? readChatGptPlanRegistration(options.existing) : undefined;
  const hostId = await chatGptPlanHostId();
  if (existing && existing.hostId !== hostId) throw new Error('This ChatGPT plan registration belongs to a different host.');
  const { verifier, challenge } = await generatePkce();
  const state = generateOAuthState();
  const nonce = generateOAuthState();
  const { code, clientId, redirectUri } = await receiveChatGptPlanCallback({
    state, signal, existingClientId: existing?.clientId,
    openAuthorization: redirect => {
      const url = new URL(CHATGPT_PLAN_ISSUER + '/api/accounts/authorize');
      url.search = new URLSearchParams({
        client_id: existing?.clientId ?? 'dynamic_agent_client',
        ...(existing ? {} : { agent_name_hint: 'Leverframe' }),
        ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect,
        scope: SCOPES, resource: OPENAI_CHATGPT_PLAN_BASE_URL, state, nonce,
        code_challenge_method: 'S256', code_challenge: challenge,
      }).toString();
      options.openBrowser(url.href);
    },
  });
  const tokens = await requestPlanTokens({
    grant_type: 'authorization_code', code, client_id: clientId,
    redirect_uri: redirectUri, code_verifier: verifier,
  }, fetchImpl, signal);
  const scopes = scopesFromGrant(tokens.scope);
  const { id_token: idToken, ...credentials } = tokens;
  if (typeof idToken !== 'string') throw new Error('OpenAI did not return a ChatGPT identity token.');
  const subject = await verifyChatGptPlanIdentity(idToken, { clientId, nonce }, fetchImpl, signal);
  if (existing && existing.subject !== subject) throw new Error('The signed-in ChatGPT account does not match the selected registration.');
  return { ...tokensToStoredCredential(credentials, undefined, clientId, { clientId, hostId, subject, scopes }), idToken };
}

export async function refreshChatGptPlanCredential(credential: StoredOAuthCredential, fetchImpl = globalThis.fetch): Promise<StoredOAuthCredential> {
  const { clientId } = readChatGptPlanRegistration(credential.providerData);
  if (!credential.refresh) throw new Error('ChatGPT plan refresh token missing. Sign in again.');
  const savedScopes = scopesFromGrant(Array.isArray(credential.providerData?.scopes)
    ? credential.providerData.scopes.join(' ') : undefined);
  const { id_token: _idToken, scope, ...tokens } = await requestPlanTokens({
    grant_type: 'refresh_token', client_id: clientId, refresh_token: credential.refresh,
  }, fetchImpl);
  const scopes = scope === undefined ? savedScopes : scopesFromGrant(scope);
  return {
    ...tokensToStoredCredential(tokens, undefined, clientId, { ...credential.providerData, scopes }),
    ...(typeof credential.idToken === 'string' ? { idToken: credential.idToken } : {}),
  };
}
