import { randomUUID } from 'node:crypto';
import { VERSION } from './constants.js';

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/inference/openai/v1';
export const OPENCODE_ZEN_MODELS_URL = 'https://opencode.ai/inference/v1/models';
const projectId = randomUUID();

export function isOpenCodeZenUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://opencode.ai' && !url.username && !url.password
      && !url.search && !url.hash && /^\/inference\/openai\/v1(?:\/chat\/completions)?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function openCodeZenHeaders(headers?: Record<string, string>, sessionId?: string): Record<string, string> {
  const result = new Headers(headers);
  const session = sessionId || result.get('x-opencode-session') || randomUUID();
  result.set('user-agent', `opencode/leverframe/${VERSION}/leverframe`);
  result.set('x-opencode-client', 'leverframe');
  result.set('x-opencode-project', projectId);
  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'X-Session-Id']) {
    result.set(name, session);
  }
  return Object.fromEntries(result);
}

export function openCodeZenPublicHeaders(headers?: HeadersInit): Record<string, string> {
  const result = new Headers(headers);
  for (const name of ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']) result.delete(name);
  result.set('authorization', 'Bearer public');
  return Object.fromEntries(result);
}

export function openCodeZenCredentialNotice(baseURL: string | undefined, apiKey: string | null): string | undefined {
  if (!isOpenCodeZenUrl(baseURL ?? OPENCODE_ZEN_BASE_URL)) return undefined;
  if (!apiKey?.trim() || apiKey.trim() === 'public') return undefined;
  return 'OpenCode Zen uses the public credential. The configured key is not sent.';
}
