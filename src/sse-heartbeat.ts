export const DELAY_FIRST_HEARTBEAT = true;

export interface SseHeartbeat {
  arm(): void;
  reset(): void;
  clear(): void;
}

export function createSseHeartbeat(
  write: () => void,
  canWrite: () => boolean = () => true,
  delayFirst = false,
): SseHeartbeat {
  const configured = Number.parseInt(process.env['LEVERFRAME_SSE_HEARTBEAT_MS'] ?? '', 10);
  const intervalMs = Number.isFinite(configured) ? Math.max(0, configured) : 15_000;
  const firstIntervalMs = delayFirst ? intervalMs * 2 : intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;

  const clear = () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (canWrite()) write();
      if (active) schedule(intervalMs);
    }, delay);
    timer.unref?.();
  };
  const arm = () => {
    clear();
    if (intervalMs === 0) return;
    active = true;
    schedule(firstIntervalMs);
  };
  const reset = () => {
    clear();
    if (intervalMs === 0) return;
    active = true;
    schedule(intervalMs);
  };

  return { arm, reset, clear };
}
