import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSseHeartbeat, DELAY_FIRST_HEARTBEAT } from '../src/sse-heartbeat.js';

const previousHeartbeat = process.env['LEVERFRAME_SSE_HEARTBEAT_MS'];

afterEach(() => {
  vi.useRealTimers();
  if (previousHeartbeat === undefined) delete process.env['LEVERFRAME_SSE_HEARTBEAT_MS'];
  else process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = previousHeartbeat;
});

describe('createSseHeartbeat', () => {
  it('arms, resets, and clears the timer', () => {
    vi.useFakeTimers();
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '10';
    const write = vi.fn();
    const heartbeat = createSseHeartbeat(write);

    heartbeat.arm();
    vi.advanceTimersByTime(9);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    heartbeat.reset();
    vi.advanceTimersByTime(9);
    expect(write).toHaveBeenCalledTimes(1);
    heartbeat.clear();
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('uses the environment interval and supports disabling', () => {
    vi.useFakeTimers();
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '25';
    const write = vi.fn();
    createSseHeartbeat(write).arm();
    vi.advanceTimersByTime(24);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);

    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '0';
    const disabledWrite = vi.fn();
    createSseHeartbeat(disabledWrite).arm();
    vi.advanceTimersByTime(100);
    expect(disabledWrite).not.toHaveBeenCalled();
  });
});

describe('createSseHeartbeat guards', () => {
  it('waits while the writable guard is false', () => {
    vi.useFakeTimers();
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '10';
    const write = vi.fn();
    let writable = false;
    createSseHeartbeat(write, () => writable).arm();
    vi.advanceTimersByTime(10);
    expect(write).not.toHaveBeenCalled();
    writable = true;
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('delays only the first ping when requested', () => {
    vi.useFakeTimers();
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '10';
    const write = vi.fn();
    createSseHeartbeat(write, () => true, DELAY_FIRST_HEARTBEAT).arm();
    vi.advanceTimersByTime(10);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm when writing clears the heartbeat', () => {
    vi.useFakeTimers();
    process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] = '10';
    let heartbeat: ReturnType<typeof createSseHeartbeat>;
    const write = vi.fn(() => heartbeat.clear());
    heartbeat = createSseHeartbeat(write);
    heartbeat.arm();
    vi.advanceTimersByTime(30);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
