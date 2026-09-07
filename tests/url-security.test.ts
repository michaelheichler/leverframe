import { describe, expect, it } from 'vitest';
import { revalidateEndpointUrl } from '../src/server/route-helpers.js';

describe('server custom endpoint URL policy', () => {
  it('allows loopback HTTP for local model servers', async () => {
    await expect(revalidateEndpointUrl('http://127.0.0.1:11434')).resolves.toMatchObject({ ok: true });
  });

  it('rejects HTTP endpoints that are not local addresses', async () => {
    await expect(revalidateEndpointUrl('http://198.51.100.1:8080')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/local|private|HTTPS/i),
    });
  });
});
