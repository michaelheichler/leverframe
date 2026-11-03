import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launcherPid, onParentExit } from '../src/http-proxy/parent-watch.js';

const POLL_MS = 50;
const LAUNCHER = 4242;

let stopWatch: (() => void) | undefined;
let child: ChildProcess | undefined;

afterEach(() => {
  stopWatch?.();
  stopWatch = undefined;
  child?.kill('SIGKILL');
  child = undefined;
  vi.useRealTimers();
});

describe('launcherPid', () => {
  it.each([
    ['a real launcher pid', { LEVERFRAME_PARENT_PID: '4242' }, 4242],
    ['a missing variable', {}, undefined],
    ['a non-numeric value', { LEVERFRAME_PARENT_PID: 'launcher' }, undefined],
    ['a fractional value', { LEVERFRAME_PARENT_PID: '12.5' }, undefined],
    ['pid 0, which names the process group', { LEVERFRAME_PARENT_PID: '0' }, undefined],
    ['pid 1, the init process an orphan is reparented to', { LEVERFRAME_PARENT_PID: '1' }, undefined],
  ])('resolves %s to the launcher to watch', (_label, env, expected) => {
    expect(launcherPid(env)).toBe(expected);
  });
});

describe('onParentExit polling', () => {
  it('does not exit while the launcher stays alive', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    stopWatch = onParentExit(LAUNCHER, exit, () => true, POLL_MS);

    vi.advanceTimersByTime(POLL_MS * 10);

    expect(exit).not.toHaveBeenCalled();
  });

  it('exits exactly once after the watched launcher disappears', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const deadPids = new Set<number>();
    stopWatch = onParentExit(LAUNCHER, exit, pid => !deadPids.has(pid), POLL_MS);
    vi.advanceTimersByTime(POLL_MS);
    deadPids.add(LAUNCHER);

    vi.advanceTimersByTime(POLL_MS * 10);

    expect(exit).toHaveBeenCalledOnce();
  });

  it('never exits after the watch is stopped', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const stop = onParentExit(LAUNCHER, exit, () => false, POLL_MS);
    stop();

    vi.advanceTimersByTime(POLL_MS * 10);

    expect(exit).not.toHaveBeenCalled();
  });
});

describe('onParentExit with the default liveness check', () => {
  it('exits only after a real launcher process is killed', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const exit = vi.fn();
    stopWatch = onParentExit(child.pid as number, exit, undefined, 10);
    await delay(80);
    const exitsWhileAlive = exit.mock.calls.length;

    child.kill('SIGKILL');
    await once(child, 'exit');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(exitsWhileAlive).toBe(0);
  });

  it('keeps running while the launcher exists but may not be signalled', async () => {
    const exit = vi.fn();
    stopWatch = onParentExit(1, exit, undefined, 10);

    await delay(80);

    expect(exit).not.toHaveBeenCalled();
  });
});
