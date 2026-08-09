import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { WorkerSupervisor, WorkerSupervisorError } from '../src/context/worker-supervisor.js';
import type { ChildProcess } from 'node:child_process';

const fixture = fileURLToPath(new URL('./fixtures/worker-fixture.mjs', import.meta.url));
const supervisors: WorkerSupervisor[] = [];

function supervisor(mode = 'normal', options: { defaultTimeoutMs?: number; maxInFlight?: number; spawn?: (executable: string, args: readonly string[]) => ChildProcess } = {}): WorkerSupervisor {
  const instance = new WorkerSupervisor({ executable: process.execPath, args: [fixture, mode], ...options });
  supervisors.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(instance => instance.shutdown().catch(() => undefined)));
  delete process.env.WORKER_FIXTURE_STATE;
});

describe('worker supervisor', () => {
  it('correlates summarize and embedding responses', async () => {
    const worker = supervisor();
    await expect(worker.health()).resolves.toMatchObject({ ok: true });
    await expect(worker.summarize('fixture text', ['group-1'])).resolves.toEqual({ summary: 'summary:fixture text', provenanceIds: ['group-1'] });
    const query = await worker.embedQuery('query');
    const documents = await worker.embedDocuments(['one', 'two']);
    expect(query).toHaveLength(1024);
    expect(documents).toHaveLength(2);
    expect(Math.abs(Math.sqrt(query.reduce((sum, value) => sum + value * value, 0)) - 1)).toBeLessThan(0.01);
  });

  it('times out and sends cancellation without exposing payload text', async () => {
    const worker = supervisor('delayed');
    await expect(worker.summarize('private-sentinel', [], 10)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('ignores a late timed-out response without killing a concurrent request', async () => {
    const worker = supervisor('late-response', { maxInFlight: 2 });
    const timedOut = worker.summarize('private-sentinel', [], 10);
    const concurrent = worker.health(500);
    await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    await expect(concurrent).resolves.toMatchObject({ ok: true });
  });

  it('rejects invalid outbound requests and timeouts before spawning', async () => {
    let spawnCount = 0;
    const worker = supervisor('normal', {
      spawn: (() => {
        spawnCount += 1;
        throw new Error('spawned');
      }) as (executable: string, args: readonly string[]) => ChildProcess
    });
    await expect(worker.summarize('x'.repeat(16 * 1024 + 1), [])).rejects.toMatchObject({ code: 'invalid_schema' });
    await expect(worker.health(0)).rejects.toMatchObject({ code: 'invalid_timeout' });
    expect(spawnCount).toBe(0);
  });

  it('bounds recent response ID tracking', async () => {
    const worker = supervisor();
    for (let index = 0; index < 300; index += 1) await worker.health();
    expect(worker.responseIdTrackingSize).toBeLessThanOrEqual(256);
  });

  it('rejects a crashed request and restarts on the next request', async () => {
    const state = join(mkdtempSync(join(tmpdir(), 'leverframe-worker-')), 'state');
    process.env.WORKER_FIXTURE_STATE = state;
    const worker = supervisor('crash-once');
    await expect(worker.health(500)).rejects.toMatchObject({ code: 'worker_crash' });
    await expect(worker.health(500)).resolves.toMatchObject({ ok: true });
    rmSync(state, { force: true });
  });

  it('redacts and bounds stderr', async () => {
    const worker = supervisor('stderr');
    await worker.health();
    expect(worker.stderrDiagnostic).toMatch(/^\[worker stderr redacted: \d+ bytes\]$/);
    expect(worker.stderrDiagnostic).not.toContain('cobalt-lantern-phrase');
    expect(worker.stderrDiagnostic.length).toBeLessThanOrEqual(8192);
  });

  it('enforces the in-flight bound and shuts down gracefully', async () => {
    const worker = supervisor('delayed', { maxInFlight: 1 });
    const first = worker.health(500);
    await expect(worker.health(500)).rejects.toMatchObject({ code: 'in_flight_limit' });
    await first;
    await expect(worker.unload()).resolves.toBeUndefined();
    await expect(worker.shutdown()).resolves.toBeUndefined();
  });

  it('rejects malformed frames and invalid embedding dimensions or normalization', async () => {
    await expect(supervisor('malformed').health()).rejects.toBeInstanceOf(Error);
    await expect(supervisor('bad-dimension').embedQuery('x')).rejects.toMatchObject({ code: 'invalid_embedding' });
    await expect(supervisor('bad-normalization').embedQuery('x')).rejects.toMatchObject({ code: 'invalid_embedding' });
  });

  it('rejects a duplicate response ID and fails other in-flight requests', async () => {
    const worker = supervisor('duplicate', { maxInFlight: 2 });
    const first = worker.health();
    const second = worker.health();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).rejects.toMatchObject({ code: 'duplicate_response_id' });
  });

  it('rejects invalid supervisor configuration', () => {
    expect(() => new WorkerSupervisor({ executable: '', args: [] })).toThrowError(WorkerSupervisorError);
    expect(() => new WorkerSupervisor({ executable: 'node\0bad', args: [] })).toThrowError(WorkerSupervisorError);
  });
});