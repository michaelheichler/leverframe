import { createPublicKey, randomUUID, verify, type JsonWebKey } from 'node:crypto';
import { join } from 'node:path';
import { durableAtomicWrite, readFileStrict } from '../durable-io.js';
import { getAppHome } from '../paths.js';
import { withCredentialMutationLock } from '../registry/lock.js';

export const CHATGPT_PLAN_ISSUER = 'https://auth.openai.com';
export const CHATGPT_PLAN_HOST_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function chatGptPlanHostId(): Promise<string> {
  const path = join(getAppHome(), 'chatgpt-plan-host-id');
  return withCredentialMutationLock('chatgpt-plan-host-id', () => {
    try {
      const id = readFileStrict(path, { maxBytes: 64, requirePrivateMode: true }).trim();
      if (!CHATGPT_PLAN_HOST_ID.test(id)) throw new Error('Invalid ChatGPT plan host ID.');
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const id = `urn:uuid:${randomUUID()}`;
      durableAtomicWrite(path, id + '\n');
      return id;
    }
  });
}

function decodeTokenPart(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JWT payload.');
  return parsed as Record<string, unknown>;
}

export async function verifyChatGptPlanIdentity(
  token: string,
  expected: { clientId: string; nonce: string },
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid JWT.');
    const [header, payload, signature] = parts as [string, string, string];
    const { alg, kid } = decodeTokenPart(header);
    if (alg !== 'RS256' || typeof kid !== 'string') throw new Error('Invalid signing algorithm or key ID.');
    const response = await fetchImpl(CHATGPT_PLAN_ISSUER + '/.well-known/jwks.json', { signal, redirect: 'error' });
    if (!response.ok) throw new Error('OpenAI signing keys are unavailable.');
    const { keys } = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
    const jwk = keys?.find(key => key.kid === kid && key.kty === 'RSA');
    if (!jwk || !verify('RSA-SHA256', Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
      throw new Error('Invalid JWT signature.');
    }
    const { aud, azp, exp, iss, nbf, nonce, sub } = decodeTokenPart(payload);
    const audience = Array.isArray(aud) ? aud : [aud];
    const now = Date.now() / 1000;
    if (iss !== CHATGPT_PLAN_ISSUER || !audience.includes(expected.clientId) || nonce !== expected.nonce
      || ((audience.length > 1 || azp !== undefined) && azp !== expected.clientId)
      || typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now
      || (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || nbf > now))
      || typeof sub !== 'string' || !sub.trim()) {
      throw new Error('Invalid identity claims.');
    }
    return sub;
  } catch (error) {
    throw new Error('OpenAI returned an invalid ChatGPT identity token.', { cause: error });
  }
}
