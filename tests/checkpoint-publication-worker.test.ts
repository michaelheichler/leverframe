import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    linkSync: (...args: Parameters<typeof original.linkSync>) => {
      try { return original.linkSync(...args); }
      catch (error) {
        const home = process.env.LEVERFRAME_CAS_WORKER_HOME;
        if (home && process.env.LEVERFRAME_CAS_WORKER_ID === 'b'
          && String(args[1]).endsWith('checkpoint.json.lock')
          && (error as NodeJS.ErrnoException).code === 'EEXIST') {
          original.writeFileSync(join(home, 'contended-b'), 'ready');
        }
        throw error;
      }
    },
  };
});

vi.mock('../src/durable-io.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/durable-io.js')>();
  return {
    ...original,
    durableAtomicWrite: (...args: Parameters<typeof original.durableAtomicWrite>) => {
      const home = process.env.LEVERFRAME_CAS_WORKER_HOME;
      if (home && process.env.LEVERFRAME_CAS_WORKER_ID === 'a') {
        writeFileSync(join(home, 'publishing'), 'ready');
        const deadline = Date.now() + 10_000;
        while (!existsSync(join(home, 'release'))) {
          if (Date.now() > deadline) throw new Error('Publication barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return original.durableAtomicWrite(...args);
    },
  };
});

it('publishes through the production checkpoint entry point in a bounded child', async () => {
  const home = process.env.LEVERFRAME_CAS_WORKER_HOME;
  if (!home) {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'leverframe-cas-standalone-'));
    vi.stubEnv('LEVERFRAME_HOME', isolatedHome);
    try {
      const { createInitialCheckpoint, loadCheckpoint, saveCheckpointCAS } = await import('../src/execution-checkpoint.js');
      const next = createInitialCheckpoint({ executionId: 'standalone', requestId: 'seed', provider: 'fake', model: 'fake', route: 'passthrough', messages: [] });
      expect(saveCheckpointCAS({ scopeHash: 'scope', expectedCurrentGeneration: 0, next })).toEqual({ ok: true, generation: 1 });
      expect(saveCheckpointCAS({ scopeHash: 'scope', expectedCurrentGeneration: 0, next })).toEqual({ ok: false, reason: 'conflict', currentGeneration: 1 });
      expect(loadCheckpoint('scope', 'standalone').value).toEqual(next);
    } finally {
      vi.unstubAllEnvs();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
    return;
  }
  expect(home).toBe(process.env.LEVERFRAME_HOME);
  expect(readFileSync(join(home, '.cas-worker-capability'), 'utf8')).toBe(process.env.LEVERFRAME_CAS_CAPABILITY);
  const { loadCheckpoint, saveCheckpointCAS, advanceCheckpoint } = await import('../src/execution-checkpoint.js');
  const checkpoint = loadCheckpoint('scope', 'execution').value;
  if (!checkpoint) throw new Error('Missing seeded checkpoint');
  expect(checkpoint.generation).toBe(1);
  writeFileSync(join(home, `ready-${process.env.LEVERFRAME_CAS_WORKER_ID}`), 'ready');
  const next = advanceCheckpoint({ checkpoint, patch: { requestId: process.env.LEVERFRAME_CAS_WORKER_ID } });
  const result = saveCheckpointCAS({ scopeHash: 'scope', expectedCurrentGeneration: 1, next });
  writeFileSync(join(home, `result-${process.env.LEVERFRAME_CAS_WORKER_ID}`), JSON.stringify(result));
});
