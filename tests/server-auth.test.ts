import { describe, expect, it } from 'vitest';
import {
  extractBearerToken,
  generateLocalGatewayToken,
  isAuthorized,
  isLocalHostHeaderValue,
  isLocalHostRequestAllowed,
  isAbsoluteFormRequestTarget,
  sanitizeCredential,
} from '../src/server/auth.js';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/test', { headers });
}

describe('server auth', () => {
  it('accepts every request when serverPassword is null', () => {
    expect(isAuthorized(request(), null)).toBe(true);
    expect(isAuthorized(request({ authorization: 'Bearer wrong' }), null)).toBe(true);
  });

  it('accepts a matching bearer token', () => {
    expect(isAuthorized(request({ authorization: 'Bearer secret' }), 'secret')).toBe(true);
  });

  it('accepts a matching x-api-key header', () => {
    expect(isAuthorized(request({ 'x-api-key': 'secret' }), 'secret')).toBe(true);
  });

  it('rejects missing and wrong passwords', () => {
    expect(isAuthorized(request(), 'secret')).toBe(false);
    expect(isAuthorized(request({ authorization: 'Bearer wrong' }), 'secret')).toBe(false);
    expect(isAuthorized(request({ 'x-api-key': 'wrong' }), 'secret')).toBe(false);
  });

  it('ignores pasted notes after a newline in gateway credentials', () => {
    expect(sanitizeCredential('secret\n\ncc-claw:notes')).toBe('secret');
    expect(extractBearerToken('Bearer secret\n\nFor laptop:notes')).toBe('secret');
    expect(isAuthorized(request({ authorization: 'Bearer secret' }), 'secret')).toBe(true);
  });
});

describe('isLocalHostHeaderValue strict loopback set', () => {
  it('accepts the three exact forms without a port', () => {
    expect(isLocalHostHeaderValue('127.0.0.1')).toBe(true);
    expect(isLocalHostHeaderValue('localhost')).toBe(true);
    expect(isLocalHostHeaderValue('[::1]')).toBe(true);
  });

  it('accepts the three exact forms with a decimal port 1-65535', () => {
    expect(isLocalHostHeaderValue('127.0.0.1:1')).toBe(true);
    expect(isLocalHostHeaderValue('127.0.0.1:17645')).toBe(true);
    expect(isLocalHostHeaderValue('127.0.0.1:65535')).toBe(true);
    expect(isLocalHostHeaderValue('localhost:1')).toBe(true);
    expect(isLocalHostHeaderValue('localhost:17645')).toBe(true);
    expect(isLocalHostHeaderValue('localhost:65535')).toBe(true);
    expect(isLocalHostHeaderValue('[::1]:1')).toBe(true);
    expect(isLocalHostHeaderValue('[::1]:17645')).toBe(true);
    expect(isLocalHostHeaderValue('[::1]:65535')).toBe(true);
  });

  it('is case-insensitive on host and bracket forms', () => {
    expect(isLocalHostHeaderValue('LOCALHOST')).toBe(true);
    expect(isLocalHostHeaderValue('LocalHost:17645')).toBe(true);
    expect(isLocalHostHeaderValue('127.0.0.1')).toBe(true);
    expect(isLocalHostHeaderValue('[::1]')).toBe(true);
  });

  it('rejects port 0 (reserved) and out-of-range ports', () => {
    expect(isLocalHostHeaderValue('localhost:0')).toBe(false);
    expect(isLocalHostHeaderValue('127.0.0.1:0')).toBe(false);
    expect(isLocalHostHeaderValue('[::1]:0')).toBe(false);
    expect(isLocalHostHeaderValue('localhost:65536')).toBe(false);
    expect(isLocalHostHeaderValue('localhost:99999')).toBe(false);
  });

  it('rejects non-decimal ports', () => {
    expect(isLocalHostHeaderValue('localhost:')).toBe(false);
    expect(isLocalHostHeaderValue('localhost:abc')).toBe(false);
    expect(isLocalHostHeaderValue('localhost:-1')).toBe(false);
    expect(isLocalHostHeaderValue('localhost:0x10')).toBe(false);
    expect(isLocalHostHeaderValue('localhost: 80')).toBe(false);
  });

  it('rejects userinfo forms', () => {
    expect(isLocalHostHeaderValue('user@localhost')).toBe(false);
    expect(isLocalHostHeaderValue('user:pass@localhost')).toBe(false);
    expect(isLocalHostHeaderValue('user@localhost:17645')).toBe(false);
  });

  it('rejects trailing dots and external hosts', () => {
    expect(isLocalHostHeaderValue('localhost.')).toBe(false);
    expect(isLocalHostHeaderValue('localhost.:17645')).toBe(false);
    expect(isLocalHostHeaderValue('127.0.0.1.')).toBe(false);
    expect(isLocalHostHeaderValue('victim.example')).toBe(false);
    expect(isLocalHostHeaderValue('victim.example:17645')).toBe(false);
    expect(isLocalHostHeaderValue('192.168.1.5')).toBe(false);
    expect(isLocalHostHeaderValue('10.0.0.1:17645')).toBe(false);
    expect(isLocalHostHeaderValue('evil.com')).toBe(false);
    expect(isLocalHostHeaderValue('[127.0.0.1]')).toBe(false);
  });

  it('rejects bare ::1 (must be bracketed per RFC 3986)', () => {
    expect(isLocalHostHeaderValue('::1')).toBe(false);
    expect(isLocalHostHeaderValue('::1:17645')).toBe(false);
  });

  it('rejects malformed brackets and bracket suffixes', () => {
    expect(isLocalHostHeaderValue('[::1')).toBe(false);
    expect(isLocalHostHeaderValue('[::1]]')).toBe(false);
    expect(isLocalHostHeaderValue('[::1]abc')).toBe(false);
    expect(isLocalHostHeaderValue('[::1]:17645abc')).toBe(false);
    expect(isLocalHostHeaderValue('[localhost]')).toBe(false);
    expect(isLocalHostHeaderValue('[]')).toBe(false);
  });

  it('rejects empty and whitespace input', () => {
    expect(isLocalHostHeaderValue('')).toBe(false);
    expect(isLocalHostHeaderValue('   ')).toBe(false);
    expect(isLocalHostHeaderValue('\t')).toBe(false);
  });

  it('trims leading/trailing OWS but rejects embedded whitespace in host', () => {
    expect(isLocalHostHeaderValue('  localhost  ')).toBe(true);
    expect(isLocalHostHeaderValue('\tlocalhost\t')).toBe(true);
    expect(isLocalHostHeaderValue('local host')).toBe(false);
    expect(isLocalHostHeaderValue('127.0.0.1 :80')).toBe(false);
  });
});

describe('isAbsoluteFormRequestTarget', () => {
  it('detects http(s) absolute-form request targets', () => {
    expect(isAbsoluteFormRequestTarget('http://example.com/')).toBe(true);
    expect(isAbsoluteFormRequestTarget('https://example.com/path?q=1')).toBe(true);
    expect(isAbsoluteFormRequestTarget('HTTP://EXAMPLE.COM/')).toBe(true);
  });

  it('passes origin-form, asterisk, and authority-form through as not absolute', () => {
    expect(isAbsoluteFormRequestTarget('/anthropic/v1/messages')).toBe(false);
    expect(isAbsoluteFormRequestTarget('/')).toBe(false);
    expect(isAbsoluteFormRequestTarget('*')).toBe(false);
    expect(isAbsoluteFormRequestTarget('example.com:443')).toBe(false);
    expect(isAbsoluteFormRequestTarget(undefined)).toBe(false);
  });
});

function fakeReq(args: { rawHeaders?: string[]; url?: string }): { rawHeaders: string[]; url: string | undefined } {
  return { rawHeaders: args.rawHeaders ?? [], url: args.url };
}

describe('isLocalHostRequestAllowed raw-header gate', () => {
  it('accepts a single valid loopback Host with origin-form target', () => {
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', '127.0.0.1:17645'],
      url: '/anthropic/v1/messages',
    }))).toBe(true);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', 'localhost'],
      url: '/health',
    }))).toBe(true);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', '[::1]:17645'],
      url: '/openai/v1/models',
    }))).toBe(true);
  });

  it('rejects a missing Host header', () => {
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['User-Agent', 'curl/8'],
      url: '/health',
    }))).toBe(false);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: [],
      url: '/health',
    }))).toBe(false);
  });

  it('rejects duplicate Host headers even if the first is loopback', () => {
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', 'localhost', 'Host', 'evil.example'],
      url: '/health',
    }))).toBe(false);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['host', 'localhost', 'Host', '127.0.0.1'],
      url: '/health',
    }))).toBe(false);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', '127.0.0.1', 'Host', '127.0.0.1'],
      url: '/health',
    }))).toBe(false);
  });

  it('rejects absolute-form request targets outright', () => {
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', '127.0.0.1'],
      url: 'http://victim.example/anthropic/v1/messages',
    }))).toBe(false);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', '127.0.0.1'],
      url: 'https://127.0.0.1/health',
    }))).toBe(false);
  });

  it('rejects an external Host value', () => {
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', 'victim.example'],
      url: '/health',
    }))).toBe(false);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['Host', '192.168.1.5:17645'],
      url: '/health',
    }))).toBe(false);
  });

  it('uses case-insensitive header name matching', () => {
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['HOST', 'localhost'],
      url: '/health',
    }))).toBe(true);
    expect(isLocalHostRequestAllowed(fakeReq({
      rawHeaders: ['hOsT', 'localhost:17645'],
      url: '/health',
    }))).toBe(true);
  });
});

describe('generateLocalGatewayToken', () => {
  it('returns a non-empty base64url string', () => {
    const token = generateLocalGatewayToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('does not repeat across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) seen.add(generateLocalGatewayToken());
    expect(seen.size).toBe(32);
  });
});
