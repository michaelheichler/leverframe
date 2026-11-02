import { ANTIGRAVITY_REQUEST_TIMEOUT_MS, AntigravityError, objectRecord } from './types.js';

export async function readGoogleJson(response: Response, limit = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new AntigravityError('Antigravity returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AntigravityError('Antigravity response exceeds the size limit.');
      chunks.push(value);
    }
    const result = objectRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!result) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof AntigravityError) throw error;
    throw new AntigravityError('Antigravity returned an invalid response.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function googleRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ANTIGRAVITY_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function requestGoogleJson(url: string, init: RequestInit, fetchImpl: typeof fetch = globalThis.fetch, observe?: (payload: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const signal = googleRequestSignal(init.signal ?? undefined);
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal, redirect: 'manual' });
  } catch {
    throw new AntigravityError(signal.aborted ? 'Antigravity request cancelled or timed out.' : 'Antigravity connection failed.');
  }
  if (!response.ok) {
    let payload: Record<string, unknown> | undefined;
    try { payload = await readGoogleJson(response, 64 * 1024); } catch { /* Invalid error bodies carry no trusted metadata. */ }
    if (payload) observe?.(payload);
    const error = objectRecord(payload?.error);
    const details = Array.isArray(error?.details) ? error.details.map(objectRecord) : [];
    const reason = details.find(item => item?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason ?? error?.status;
    const safeReason = typeof reason === 'string' && /^[A-Z_]{1,64}$/.test(reason) ? reason : undefined;
    const verification = safeReason?.includes('VERIFICATION') ? ' Complete Google account verification before trying again.' : '';
    throw new AntigravityError(`Antigravity request failed (HTTP ${response.status}${safeReason ? `, ${safeReason}` : ''}).${verification}`, response.status, safeReason);
  }
  const payload = await readGoogleJson(response);
  observe?.(payload);
  return payload;
}
