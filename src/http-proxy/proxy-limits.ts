import { connect, type Socket } from 'node:net';

export const PROXY_MAX_CONNECTIONS = 256;
export const TCP_KEEPALIVE_INITIAL_DELAY_MS = 30_000;
export const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;

export interface ProxyLimits {
  maxConnections?: number;
  tunnelConnectTimeoutMs?: number;
  connect?: (port: number, host: string) => Socket;
}

export function resolveProxyLimits(limits: ProxyLimits): Required<ProxyLimits> {
  const maxConnections = limits.maxConnections ?? PROXY_MAX_CONNECTIONS;
  const tunnelConnectTimeoutMs = limits.tunnelConnectTimeoutMs ?? TUNNEL_CONNECT_TIMEOUT_MS;
  if ([maxConnections, tunnelConnectTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError('Proxy connection budgets must be positive safe integers.');
  }
  return { maxConnections, tunnelConnectTimeoutMs, connect: limits.connect ?? connect };
}
