import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createInitialCheckpoint, loadCheckpoint, saveCheckpointCAS } from '../src/execution-checkpoint.js';

async function waitFor(...paths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.some(path => existsSync(path))) {
    if (Date.now() > deadline) throw new Error(`Missing markers: ${paths.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function worker(home: string, id: string, capability: string) {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/checkpoint-publication-worker.test.ts'], {
    env: { ...process.env, HOME: home, LEVERFRAME_HOME: home, LEVERFRAME_CAS_WORKER_HOME: home,
      LEVERFRAME_CAS_WORKER_ID: id, LEVERFRAME_CAS_CAPABILITY: capability },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Worker ${id} exited ${code}: ${output}`));
    });
  });
  return { child, finished };
}

it('serializes production checkpoint comparison and publication across processes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-cas-'));
  const capability = randomUUID();
  vi.stubEnv('LEVERFRAME_HOME', home);
  writeFileSync(join(home, '.cas-worker-capability'), capability, { mode: 0o600 });
  const next = createInitialCheckpoint({ executionId: 'execution', requestId: 'seed', provider: 'fake', model: 'fake', route: 'passthrough', messages: [] });
  expect(saveCheckpointCAS({ scopeHash: 'scope', expectedCurrentGeneration: 0, next }).ok).toBe(true);
  const workers: ReturnType<typeof worker>[] = [];
  try {
    workers.push(worker(home, 'a', capability));
    await waitFor(join(home, 'publishing'));
    workers.push(worker(home, 'b', capability));
    await waitFor(join(home, 'ready-b'));
    await waitFor(join(home, 'contended-b'), join(home, 'result-b'));
    writeFileSync(join(home, 'release'), 'release');
    await Promise.all(workers.map(item => item.finished));
    const results = ['a', 'b'].map(id => JSON.parse(readFileSync(join(home, `result-${id}`), 'utf8')));
    expect(results).toEqual([{ ok: true, generation: 2 }, { ok: false, reason: 'conflict', currentGeneration: 2 }]);
    expect(loadCheckpoint('scope', 'execution').value?.requestId).toBe('a');
  } finally {
    for (const item of workers) if (item.child.exitCode === null) item.child.kill('SIGKILL');
    await Promise.allSettled(workers.map(item => item.finished));
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
