// src/wrapper-env.ts
import type { ServerRuntimeState } from './server-runtime.js';
import { applyAnthropicProxyEnvNormalization } from './env.js';

const PROXY_ENV_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const;

export const PROXY_AUTH_USER = 'leverframe';

export function computeWrapperEnv(
  baseEnv: NodeJS.ProcessEnv,
  state: ServerRuntimeState | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (!state) return env;

  if (state.mode === 'proxy') {
    applyAnthropicProxyEnvNormalization(env);
    const proxyUrl = state.token
      ? `http://${PROXY_AUTH_USER}:${encodeURIComponent(state.token)}@127.0.0.1:${state.port}`
      : `http://127.0.0.1:${state.port}`;
    for (const name of PROXY_ENV_VARS) env[name] = proxyUrl;
    if (state.caPath) env['NODE_EXTRA_CA_CERTS'] = state.caPath;
    return env;
  }

  for (const name of PROXY_ENV_VARS) delete env[name];
  env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${state.port}/anthropic`;
  if (state.token) {
    env['ANTHROPIC_API_KEY'] = state.token;
  } else {
    delete env['ANTHROPIC_API_KEY'];
  }
  return env;
}
