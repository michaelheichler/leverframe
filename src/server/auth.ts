/** API keys and bearer tokens must be single-line (strip accidental paste noise). */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function sanitizeCredential(value: string | null | undefined): string | null {
  if (!value) return null;
  const firstLine = value.trim().split(/\r?\n/)[0]?.trim();
  return firstLine || null;
}

export function isAuthorized(request: Request, serverPassword: string | null): boolean {
  if (serverPassword === null) return true;

  const bearerToken = extractBearerToken(request.headers.get('authorization'));
  if (bearerToken === serverPassword) return true;

  return sanitizeCredential(request.headers.get('x-api-key')) === serverPassword;
}

export function extractBearerToken(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\r?\n/g, ' ').trim();
  const match = /^Bearer\s+(\S+)/i.exec(normalized);
  return sanitizeCredential(match?.[1]);
}

/**
 * Generate a cryptographically random per-start token for the local endpoint
 * gateway. 32 random bytes (~256 bits) base64url-encoded into ~43 URL-safe
 * chars. With a per-start secret, a stolen token dies with the process even
 * when no user password was configured.
 */
export function generateLocalGatewayToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Loopback hostnames accepted on a local-bound gateway Host header. */
export const LOCAL_ALLOWED_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
]);

/** Maximum TCP port number (IANA). Bounds the optional :port suffix. */
const MAX_TCP_PORT = 65535;

/**
 * Strict check for a single Host header value. Accepts exactly `localhost`,
 * `127.0.0.1`, or `[::1]`, each optionally followed by `:port` where port
 * is decimal 1-65535. Port 0 is reserved and rejected.
 */
export function isLocalHostHeaderValue(host: string): boolean {
  if (!host) return false;
  const value = host.replace(/^[\t ]+|[\t ]+$/g, '').toLowerCase();
  if (!value) return false;
  if (value.includes('@')) return false;

  let hostPart: string;
  let portPart: string | undefined;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return false;
    const suffix = value.slice(close + 1);
    if (suffix !== '' && suffix[0] !== ':') return false;
    hostPart = value.slice(0, close + 1);
    portPart = suffix === '' ? undefined : suffix.slice(1);
  } else {
    const colonCount = (value.match(/:/g) ?? []).length;
    if (colonCount > 1) return false;
    if (colonCount === 1) {
      const colon = value.indexOf(':');
      hostPart = value.slice(0, colon);
      portPart = value.slice(colon + 1);
    } else {
      hostPart = value;
      portPart = undefined;
    }
  }

  if (!LOCAL_ALLOWED_HOSTNAMES.has(hostPart)) return false;

  if (portPart !== undefined) {
    if (!/^[0-9]+$/.test(portPart)) return false;
    const port = Number(portPart);
    if (port < 1 || port > MAX_TCP_PORT) return false;
  }

  return true;
}

/** Detect absolute-form request targets (RFC 7230 §5.3.2), used by forward proxies. */
export function isAbsoluteFormRequestTarget(requestUrl: string | undefined): boolean {
  return typeof requestUrl === 'string' && /^https?:\/\//i.test(requestUrl);
}

/**
 * Enforce the loopback Host gate against a real HTTP request. Uses
 * `req.rawHeaders` so duplicate Host headers cannot smuggle a hostile name
 * past Node's first-wins `req.headers.host`. Requires exactly one Host
 * header whose value passes {@link isLocalHostHeaderValue}, and rejects
 * absolute-form request targets.
 */
export function isLocalHostRequestAllowed(req: Pick<IncomingMessage, 'rawHeaders' | 'url'>): boolean {
  if (isAbsoluteFormRequestTarget(req.url)) return false;

  let hostCount = 0;
  let hostValue: string | undefined;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    if (name !== undefined && String(name).toLowerCase() === 'host') {
      hostCount += 1;
      hostValue = req.rawHeaders[i + 1];
    }
  }
  if (hostCount !== 1) return false;
  if (typeof hostValue !== 'string') return false;
  return isLocalHostHeaderValue(hostValue);
}
