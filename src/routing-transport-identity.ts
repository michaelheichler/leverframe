import { createHash } from 'node:crypto';
import { OPENAI_CHATGPT_PLAN_BASE_URL, OPENAI_CHATGPT_PLAN_PROVIDER_ID } from './constants.js';
import { ANTIGRAVITY_ORIGIN } from './antigravity/types.js';
import { COPILOT_API_BASE_URL } from './copilot/backend.js';

export function routingTransportFingerprint(input: {
  endpoint: string | undefined;
  npm?: string;
  format: 'anthropic' | 'openai';
  credentialSource: 'claude-code' | 'registry';
  providerId?: string;
  authType?: 'api' | 'oauth' | 'none';
}): string | undefined {
  const endpoint = input.credentialSource === 'claude-code' ? input.endpoint
    : input.providerId === 'antigravity' ? ANTIGRAVITY_ORIGIN
    : input.providerId === 'github-copilot' || input.npm === '@github/copilot-sdk' ? COPILOT_API_BASE_URL
    : input.providerId === OPENAI_CHATGPT_PLAN_PROVIDER_ID ? OPENAI_CHATGPT_PLAN_BASE_URL : input.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return undefined;
  let url: URL;
  try { url = new URL(endpoint); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  url.username = '';
  url.password = '';
  url.hash = '';
  return createHash('sha256').update(JSON.stringify([url.href, input.npm ?? '', input.format, input.credentialSource])).digest('hex');
}
