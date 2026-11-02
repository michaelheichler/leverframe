import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverAntigravityProject } from '../src/antigravity/discovery.js';

describe('Antigravity onboarding billing enforcement', () => {
  it('latches credits observed in a provisioning poll before scheduling another poll', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-onboarding-billing-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      const requests: Array<{ url: string; method: string }> = [];
      const capture = (body: unknown) => async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method ?? 'GET' });
        return Response.json(body);
      };
      const fetchImpl = vi.fn<typeof fetch>()
        .mockImplementationOnce(capture({ allowedTiers: [{ id: 'tier-a', isDefault: true }] }))
        .mockImplementationOnce(capture({ name: 'operations/provisioning-a', done: false }))
        .mockImplementationOnce(capture({
          name: 'operations/provisioning-a', done: false,
          response: { consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1' }] },
        }));

      await expect(discoverAntigravityProject('account-a-token', undefined, fetchImpl, 'account-a'))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(discoverAntigravityProject('account-a-token', undefined, fetchImpl, 'account-a'))
        .rejects.toMatchObject({ statusCode: 409 });

      expect(requests).toHaveLength(3);
      expect(requests.map(request => request.method)).toEqual(['POST', 'POST', 'GET']);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

});

describe('Antigravity account verification errors', () => {
  it('exposes a safe structured verification reason without leaking provider prose', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-verification-error-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      const providerDetail = 'private account verification payload';
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: 403, status: 'PERMISSION_DENIED', message: providerDetail,
          details: [{
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'VERIFICATION_REQUIRED', domain: 'googleapis.com',
          }],
        },
      }), { status: 403, headers: { 'content-type': 'application/json' } }));

      const failure = await discoverAntigravityProject('account-a-token', undefined, fetchImpl, 'account-a')
        .then(() => undefined, error => error);

      expect(failure).toMatchObject({ statusCode: 403, reason: 'VERIFICATION_REQUIRED' });
      expect(failure.message).toMatch(/verification/i);
      expect(failure.message).not.toContain(providerDetail);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Antigravity discovery error billing enforcement', () => {
  it('latches consumed credits from a non-success discovery RPC response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-discovery-error-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 429, status: 'RESOURCE_EXHAUSTED' },
        consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1' }],
      }), { status: 429, headers: { 'content-type': 'application/json' } }));

      await expect(discoverAntigravityProject('account-a-token', undefined, fetchImpl, 'account-a'))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(discoverAntigravityProject('account-a-token', undefined, fetchImpl, 'account-a'))
        .rejects.toMatchObject({ statusCode: 409 });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
