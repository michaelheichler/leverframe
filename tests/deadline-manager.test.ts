import { describe, expect, it, vi } from 'vitest';
import { DeadlineManager } from '../src/deadline-manager.js';

describe('DeadlineManager', () => {
  it('fires onDeadline with the armed kind after the given delay', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ onDeadline });

    manager.arm('connect', 10);
    vi.advanceTimersByTime(9);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onDeadline).toHaveBeenCalledWith('connect');
    vi.useRealTimers();
  });

  it('is a no-op for undefined or invalid delays', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ onDeadline });

    manager.arm('idle', undefined);
    manager.arm('idle', -5);
    manager.arm('idle', Number.NaN);
    vi.advanceTimersByTime(10_000);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reset() re-arms and pushes out the deadline', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ onDeadline });

    manager.arm('idle', 20);
    vi.advanceTimersByTime(10);
    manager.reset('idle', 20);
    vi.advanceTimersByTime(10);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(11);
    expect(onDeadline).toHaveBeenCalledWith('idle');
    vi.useRealTimers();
  });

  it('clear() cancels a single armed deadline', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ onDeadline });

    manager.arm('header', 10);
    manager.clear('header');
    vi.advanceTimersByTime(20);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clearAll() cancels every armed deadline independently', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ onDeadline });

    manager.arm('connect', 10);
    manager.arm('total', 15);
    manager.clearAll();
    vi.advanceTimersByTime(50);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('tracks multiple deadline kinds independently', () => {
    vi.useFakeTimers();
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ onDeadline });

    manager.arm('connect', 5);
    manager.arm('total', 15);
    vi.advanceTimersByTime(6);
    expect(onDeadline).toHaveBeenCalledWith('connect');
    expect(onDeadline).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(onDeadline).toHaveBeenCalledWith('total');
    expect(onDeadline).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('honors a fake injected clock instead of Node timers', () => {
    let scheduled: { fn: () => void; ms: number } | undefined;
    const clock = {
      now: () => 0,
      setTimeout: (fn: () => void, ms: number) => {
        scheduled = { fn, ms };
        return {};
      },
      clearTimeout: () => { scheduled = undefined; },
    };
    const onDeadline = vi.fn();
    const manager = new DeadlineManager({ clock, onDeadline });

    manager.arm('connect', 100);
    expect(scheduled?.ms).toBe(100);
    scheduled?.fn();
    expect(onDeadline).toHaveBeenCalledWith('connect');
  });
});
