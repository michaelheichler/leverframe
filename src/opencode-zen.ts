import { randomUUID } from 'node:crypto';
import { VERSION } from './constants.js';
import type { ProviderModelSpec } from './language-model-factory.js';

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

export function configureOpenCodeZen(spec: ProviderModelSpec): ProviderModelSpec {
  if (spec.providerId !== 'opencode-zen' || !isOpenCodeZenUrl(spec.baseURL)) return spec;
  const headers = openCodeZenHeaders(spec.headers);
  const transport = spec.fetch ?? fetch;
  return {
    ...spec, apiKey: 'public', headers,
    fetch: (input, init) => {
      if (!isOpenCodeZenUrl(input instanceof Request ? input.url : String(input))) {
        return Promise.reject(new TypeError('Zen requests require the official Chat Completions endpoint.'));
      }
      const outgoing = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => outgoing.set(name, value));
      for (const name of ['x-api-key', 'api-key', 'x-goog-api-key']) outgoing.delete(name);
      outgoing.set('authorization', 'Bearer public');
      const identity = openCodeZenHeaders(Object.fromEntries(outgoing),
        outgoing.get('x-opencode-session') || headers['x-opencode-session']);
      return transport(input, { ...init, headers: identity, redirect: 'manual' });
    },
  };
}
