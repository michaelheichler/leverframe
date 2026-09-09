import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { encodeWorkerFrame, WorkerFrameDecoder } from '../src/context/worker-protocol.js';
import { WorkerSupervisor } from '../src/context/worker-supervisor.js';

function fakeChild() {
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const requests: { id: string; operation: string }[] = [];
  const decoder = new WorkerFrameDecoder();
  child.stdin.on('data', chunk => {
    for (const request of decoder.push(chunk)) requests.push(request as { id: string; operation: string });
  });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  return { child, requests, kill };
}

describe('worker child identity', () => {
  it.each(['error', 'exit', 'stdout', 'stderr', 'forged-response'] as const)('ignores delayed old-child %s after replacement', async event => {
    const old = fakeChild();
    const replacement = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(old.child).mockReturnValueOnce(replacement.child);
    const worker = new WorkerSupervisor({ executable: 'fake-worker', args: [], spawn });
    const first = worker.health();
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'worker_error' });
    old.child.emit('error', new Error('old child failed'));
    await firstRejected;
    const next = worker.health();
    const nextSucceeded = expect(next).resolves.toMatchObject({ ok: true, payload: { status: 'ok' } });
    const request = replacement.requests[0];
    expect(request?.operation).toBe('health');
    const response = encodeWorkerFrame({ id: request.id, version: 1, ok: true, payload: { status: 'ok' } });
    if (event === 'error') old.child.emit('error', new Error('delayed error'));
    if (event === 'exit') old.child.emit('exit', 1, null);
    if (event === 'stdout') old.child.stdout?.emit('data', Buffer.from([255, 255, 255, 255]));
    if (event === 'stderr') old.child.stderr?.emit('data', Buffer.from('old diagnostic'));
    if (event === 'forged-response') old.child.stdout?.emit('data', response);
    replacement.child.stdout?.emit('data', response);
    try {
      await nextSucceeded;
      expect(replacement.kill).not.toHaveBeenCalled();
      expect(worker.stderrDiagnostic).toBe('');
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      const shutdown = worker.shutdown();
      const unload = replacement.requests.find(item => item.operation === 'unload');
      if (unload) replacement.child.stdout?.emit('data', encodeWorkerFrame({ id: unload.id, version: 1, ok: true, payload: {} }));
      await shutdown;
    }
  });
});
