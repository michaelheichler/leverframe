import type { ProviderModelSpec } from './language-model-factory.js';
import { resolveTemplateCapabilities } from './provider-template-capabilities.js';
import { isOpenCodeZenUrl, openCodeZenHeaders, openCodeZenPublicHeaders } from './opencode-zen.js';

export function configureOpenCodeZen(spec: ProviderModelSpec): ProviderModelSpec {
  if (resolveTemplateCapabilities(spec)?.id !== 'opencode-zen' || !isOpenCodeZenUrl(spec.baseURL)) return spec;
  const headers = openCodeZenHeaders(openCodeZenPublicHeaders(spec.headers));
  const transport = spec.fetch ?? fetch;
  return {
    ...spec, apiKey: 'public', headers,
    fetch: (input, init) => {
      if (!isOpenCodeZenUrl(input instanceof Request ? input.url : String(input))) {
        return Promise.reject(new TypeError('Zen requests require the official Chat Completions endpoint.'));
      }
      const outgoing = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => outgoing.set(name, value));
      const identity = openCodeZenHeaders(openCodeZenPublicHeaders(outgoing),
        outgoing.get('x-opencode-session') || headers['x-opencode-session']);
      return transport(input, { ...init, headers: identity, redirect: 'manual' });
    },
  };
}
