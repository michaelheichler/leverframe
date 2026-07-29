import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateRegistry } from '../src/registry/io.js';

const mode = process.env.LEVERFRAME_REGISTRY_WORKER_MODE;

describe.skipIf(mode !== 'run')('registry lock worker', () => {
  it('performs serialized registry mutations', async () => {
    const id = process.env.LEVERFRAME_REGISTRY_WORKER_ID!;
    const rounds = Number(process.env.LEVERFRAME_REGISTRY_WORKER_ROUNDS);
    const syncDir = process.env.LEVERFRAME_REGISTRY_WORKER_SYNC!;
    writeFileSync(join(syncDir, `${id}.ready`), '');
    while (!existsSync(join(syncDir, 'start'))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    for (let round = 0; round < rounds; round += 1) {
      const providerId = `worker-${id}-${round}`;
      updateRegistry(registry => {
        registry.providers.push({
          id: providerId,
          templateId: 'worker',
          name: providerId,
          enabled: true,
          authRef: 'none:anonymous',
          authType: 'none',
          api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
          addedAt: '2026-01-01T00:00:00.000Z',
        });
      });
    }
    expect(rounds).toBeGreaterThan(0);
  });
});
