import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchAntigravityModels } from '../src/antigravity/models.js';
import { recordAntigravityCreditConsumption } from '../src/antigravity/billing-policy.js';

const auth = { accessToken: 'account-a-token', accountId: 'account-a', projectId: 'project-a' };

describe('Antigravity catalog billing policy', () => {
  it('blocks catalog refresh before network access when the account is already latched', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-catalog-billing-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      recordAntigravityCreditConsumption(auth.accountId, {
        consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1' }],
      });
      const fetchImpl = vi.fn<typeof fetch>();

      await expect(fetchAntigravityModels(auth, { fetchImpl })).rejects.toMatchObject({ statusCode: 409 });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('blocks account refresh after a catalog response reports consumed subscription credits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-catalog-billing-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
        models: { 'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro High' } },
        consumedCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '2' }],
      }));

      await expect(fetchAntigravityModels(auth, { fetchImpl })).rejects.toMatchObject({ statusCode: 409 });
      await expect(fetchAntigravityModels(auth, { fetchImpl })).rejects.toMatchObject({ statusCode: 409 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
