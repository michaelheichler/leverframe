

import type { Agent as HttpAgent } from 'node:http';

export function hasOutboundProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env['HTTPS_PROXY']?.trim()
    || env['https_proxy']?.trim()
    || env['HTTP_PROXY']?.trim()
    || env['http_proxy']?.trim(),
  );
}

export function noProxyBypasses(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'];
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    if (!entry) continue;
    if (entry === '*') return true;
    const suffix = entry.startsWith('*.') ? entry.slice(1) : entry;
    if (suffix.startsWith('.')) {
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
    } else if (host === suffix || host.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  return false;
}

export function outboundProxyUrlForTarget(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const proxy = secure
    ? env['HTTPS_PROXY'] ?? env['https_proxy']
    : env['HTTP_PROXY'] ?? env['http_proxy'];
  if (!proxy?.trim()) return undefined;
  if (noProxyBypasses(parsed.hostname, env)) return undefined;
  return proxy.trim();
}

let dispatcherInstalled = false;

export function resetOutboundProxyDispatcherForTests(): void {
  dispatcherInstalled = false;
}

export async function installOutboundProxyDispatcher(): Promise<boolean> {
  if (dispatcherInstalled) return true;
  if (!hasOutboundProxyEnv()) return false;
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    dispatcherInstalled = true;
    return true;
  } catch (err) {
    console.error(
      'leverframe: HTTP(S)_PROXY is set but installing the outbound proxy dispatcher failed; '
      + `using direct connections (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

export async function outboundWsProxyAgent(wsUrl: string): Promise<HttpAgent | undefined> {
  const proxyUrl = outboundProxyUrlForTarget(wsUrl);
  if (!proxyUrl) return undefined;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}
