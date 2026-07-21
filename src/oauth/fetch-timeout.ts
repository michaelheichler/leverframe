export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMessage: string,
  timeoutMs = OAUTH_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await operation(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
