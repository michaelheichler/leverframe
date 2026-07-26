// SSRF guard for custom provider URLs (src/registry/url-security.ts)

import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export interface UrlSecurityOptions {
  /** Allow http:// endpoints for user-approved local/LAN servers (Ollama, LM Studio, vLLM). */
  allowInsecureLocal?: boolean;
}

export interface UrlSecurityResult {
  ok: boolean;
  error?: string;
  hint?: string;
  normalizedUrl?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  '169.254.170.2',
  'fd00:ec2::254',
]);

function isBlockedIp(ipStr: string, allowInsecureLocal: boolean): boolean {
  try {
    const ip = ipaddr.process(ipStr);
    const range = ip.range();

    if (allowInsecureLocal && (range === 'loopback' || range === 'private')) {
      return false;
    }

    if (range === 'loopback') return true;
    if (range === 'private') return true;
    if (range === 'linkLocal') return true;
    if (range === 'uniqueLocal') return true;
    if (range === 'carrierGradeNat') return true;

    return false;
  } catch {
    return true; // If we can't parse it, block it to be safe
  }
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    ipaddr.parse(hostname);
    return [hostname];
  } catch {
    // Not an IP, proceed to DNS lookup
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map(r => r.address);
  } catch {
    return [];
  }
}

/** Validate a custom provider base URL before test or save. */
export async function validateCustomEndpointUrl(
  rawUrl: string,
  opts: UrlSecurityOptions = {},
): Promise<UrlSecurityResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Base URL is required.', hint: 'Example: https://api.example.com/v1' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL.', hint: 'Include https:// and the full base path.' };
  }

  const allowLocal = opts.allowInsecureLocal === true;

  if (parsed.protocol === 'http:' && !allowLocal) {
    return {
      ok: false,
      error: 'Only HTTPS URLs are allowed.',
      hint: 'For local or LAN servers (Ollama, LM Studio, vLLM), allow insecure HTTP when prompted.',
    };
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use https:// or user-approved http:// for local/LAN servers.' };
  }

  // URL parses IPv6 hosts with brackets (e.g., "[::1]"). Strip them for DNS/IP checks.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[(.*)\]$/, '$1');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      error: 'This URL points to a blocked internal/metadata host.',
      hint: 'Use a public API endpoint for your provider.',
    };
  }

  const addresses = await resolveHostAddresses(hostname);
  if (addresses.length === 0) {
    return {
      ok: false,
      error: `Could not resolve hostname: ${hostname}`,
      hint: 'Check the URL spelling and your network connection.',
    };
  }

  for (const addr of addresses) {
    try {
      ipaddr.process(addr);
    } catch {
      continue;
    }

    if (isBlockedIp(addr, allowLocal)) {
      return {
        ok: false,
        error: 'URL resolves to a private or restricted network address.',
        hint: 'Use a public HTTPS endpoint, or explicitly allow insecure HTTP for a trusted local/LAN server.',
      };
    }
  }

  if (parsed.protocol === 'http:') {
    const allResolvedAddressesAreLocal = addresses.every(addr => {
      try {
        const range = ipaddr.process(addr).range();
        return range === 'loopback' || range === 'private' || range === 'uniqueLocal';
      } catch {
        return false;
      }
    });
    if (!allowLocal || !allResolvedAddressesAreLocal) {
      return {
        ok: false,
        error: 'HTTP is only allowed for local loopback or private-network addresses.',
        hint: 'Use https://, or allow insecure HTTP for a trusted local/LAN server.',
      };
    }
  }

  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  return { ok: true, normalizedUrl };
}

interface TrustedHostRule {
  host: string;
  basePath: string;
}

const HARDCODED_TRUSTED_HOSTS: ReadonlyArray<TrustedHostRule> = [
  { host: 'api.openai.com', basePath: '/v1' },
  { host: 'api.anthropic.com', basePath: '' },
  { host: 'chatgpt.com', basePath: '/backend-api/codex' },
];

function trustedPathnameMatches(pathname: string, basePath: string): boolean {
  if (basePath === '') {
    return pathname === '/' || pathname === '';
  }
  return pathname === basePath || pathname === `${basePath}/`;
}

export function isHardcodedTrustedHost(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port !== '' && parsed.port !== '443') return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const rule = HARDCODED_TRUSTED_HOSTS.find(entry => entry.host === host);
  if (!rule) return false;
  return trustedPathnameMatches(parsed.pathname, rule.basePath);
}

export async function revalidateCustomEndpointUrl(
  rawUrl: string,
  opts: UrlSecurityOptions = {},
): Promise<UrlSecurityResult> {
  if (!rawUrl || isHardcodedTrustedHost(rawUrl)) return { ok: true, normalizedUrl: rawUrl };
  return validateCustomEndpointUrl(rawUrl, opts);
}
