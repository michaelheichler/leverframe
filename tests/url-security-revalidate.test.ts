import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

import {
  isHardcodedTrustedHost,
  revalidateCustomEndpointUrl,
  validateCustomEndpointUrl,
} from '../src/registry/url-security.js';
import { resetLegacyMigrationForTests } from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-dns-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
  lookupMock.mockReset();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  resetLegacyMigrationForTests();
});

function mockLookup(address: string): void {
  lookupMock.mockImplementation(async (hostname: string) => {
    expect(typeof hostname).toBe('string');
    return [{ address, family: 4 }];
  });
}

describe('isHardcodedTrustedHost', () => {
  it('returns true for built-in upstream hosts', () => {
    expect(isHardcodedTrustedHost('https://api.openai.com/v1')).toBe(true);
    expect(isHardcodedTrustedHost('https://api.anthropic.com')).toBe(true);
    expect(isHardcodedTrustedHost('https://chatgpt.com/backend-api/codex')).toBe(true);
  });

  it('returns false for custom and lookalike hosts', () => {
    expect(isHardcodedTrustedHost('https://api.evilopenai.com/v1')).toBe(false);
    expect(isHardcodedTrustedHost('https://api.openai.com.evil.com/v1')).toBe(false);
    expect(isHardcodedTrustedHost('')).toBe(false);
    expect(isHardcodedTrustedHost('not a url')).toBe(false);
  });

  it.each([
    ['http scheme', 'http://api.openai.com/v1'],
    ['embedded username', 'https://user@api.openai.com/v1'],
    ['embedded password', 'https://user:pass@api.openai.com/v1'],
    ['alternate port', 'https://api.openai.com:8443/v1'],
    ['explicit wrong port', 'https://api.anthropic.com:444/'],
    ['missing /v1 path on openai', 'https://api.openai.com/'],
    ['wrong openai path', 'https://api.openai.com/v2'],
    ['openai chat completions path is not a base url', 'https://api.openai.com/v1/chat/completions'],
    ['anthropic v1 path', 'https://api.anthropic.com/v1'],
    ['anthropic arbitrary path', 'https://api.anthropic.com/backend-api'],
    ['chatgpt root', 'https://chatgpt.com/'],
    ['chatgpt wrong path', 'https://chatgpt.com/backend-api/evil'],
    ['chatgpt trailing traversal', 'https://chatgpt.com/backend-api/codex/evil'],
    ['lookalike host with right path', 'https://api.openai.com.evil.com/v1'],
    ['ipv4 loopback pretending to be official', 'https://127.0.0.1/v1'],
  ])('rejects %s: %s', (_label, url) => {
    expect(isHardcodedTrustedHost(url)).toBe(false);
  });

  it.each([
    ['openai canonical', 'https://api.openai.com/v1'],
    ['openai trailing slash', 'https://api.openai.com/v1/'],
    ['openai explicit 443', 'https://api.openai.com:443/v1'],
    ['anthropic root empty path', 'https://api.anthropic.com'],
    ['anthropic root slash', 'https://api.anthropic.com/'],
    ['anthropic explicit 443 root', 'https://api.anthropic.com:443/'],
    ['chatgpt canonical', 'https://chatgpt.com/backend-api/codex'],
    ['chatgpt trailing slash', 'https://chatgpt.com/backend-api/codex/'],
  ])('accepts %s: %s', (_label, url) => {
    expect(isHardcodedTrustedHost(url)).toBe(true);
  });
});

describe('revalidateCustomEndpointUrl', () => {
  it('short-circuits hardcoded trusted hosts without any DNS lookup', async () => {
    const result = await revalidateCustomEndpointUrl('https://api.openai.com/v1');
    expect(result.ok).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects when the hostname has been rebound to a private address', async () => {
    mockLookup('93.184.216.34');
    const validatedOnce = await validateCustomEndpointUrl('https://rebind.example.com/v1');
    expect(validatedOnce.ok).toBe(true);

    mockLookup('192.168.1.5');
    const revalidated = await revalidateCustomEndpointUrl('https://rebind.example.com/v1');
    expect(revalidated.ok).toBe(false);
    expect(revalidated.error).toMatch(/private|restricted/i);
  });

  it('rejects when the hostname has been rebound to link-local metadata', async () => {
    mockLookup('169.254.169.254');
    const revalidated = await revalidateCustomEndpointUrl('https://metadata-rebind.example.com/v1');
    expect(revalidated.ok).toBe(false);
  });

  it('accepts a public hostname that still resolves publicly at request time', async () => {
    mockLookup('93.184.216.34');
    const revalidated = await revalidateCustomEndpointUrl('https://api.example.com/v1');
    expect(revalidated.ok).toBe(true);
  });

  it('does not call DNS twice for hardcoded hosts even with credentials', async () => {
    const result = await revalidateCustomEndpointUrl('https://chatgpt.com/backend-api/codex');
    expect(result.ok).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
