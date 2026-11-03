const PARENT_POLL_MS = 2_000;

export function launcherPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const pid = Number(env['LEVERFRAME_PARENT_PID']);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A SIGKILLed launcher never stops its proxy, so the proxy must notice on its own.
export function onParentExit(
  pid: number,
  exit: () => void,
  alive: (pid: number) => boolean = processAlive,
  intervalMs = PARENT_POLL_MS,
): () => void {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    exit();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
