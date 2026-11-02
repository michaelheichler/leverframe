import { randomUUID } from 'node:crypto';
import { buildAntigravityEnvelope } from './envelope.js';
import { assertAntigravityBillingAllowed, recordAntigravityCreditConsumption } from './billing-policy.js';
import { unwrapAntigravityResponse } from './response.js';
import { readGoogleJson } from './http.js';
import { createAntigravitySignatureCodec } from './signatures.js';
import { persistAntigravityToolParts, restoreAntigravityToolParts } from './tool-parts.js';
import { ANTIGRAVITY_ORIGIN, ANTIGRAVITY_SESSION_HEADER, AntigravityError, objectRecord, type AntigravityAuthSnapshot } from './types.js';

function quotaRetryDelay(error: Record<string, unknown> | undefined, header: string | null): number | undefined {
  const details = Array.isArray(error?.details) ? error.details.map(objectRecord) : [];
  const delay = details.find(item => item?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
  const value = typeof delay === 'string' && /^\d+(?:\.\d+)?s$/.test(delay) ? delay.slice(0, -1) : header;
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 604_800 ? seconds * 1000 : undefined;
}

function sdkOperation(request: Request): { modelId: string; streaming: boolean } {
  const url = new URL(request.url);
  const match = /^\/v1beta\/models\/([a-zA-Z0-9_.-]+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
  if (url.origin !== ANTIGRAVITY_ORIGIN || url.username || url.password || url.hash || request.method !== 'POST' || !match) {
    throw new AntigravityError('Antigravity subscription endpoint is not allowed.', 400);
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'alt' && key !== 'key') throw new AntigravityError('Antigravity endpoint query is unsupported.', 400);
  }
  return { modelId: match[1], streaming: match[2] === 'streamGenerateContent' };
}

async function subscriptionResponse(response: Response, observe: (payload: Record<string, unknown>) => void): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new AntigravityError('Antigravity returned an unsupported redirect.');
  }
  if (!response.ok) {
    let reason: string | undefined;
    let retryAfterMs: number | undefined;
    let body: Record<string, unknown> | undefined;
    try {
      body = await readGoogleJson(response, 64 * 1024);
    } catch { await response.body?.cancel().catch(() => {}); }
    if (body) observe(body);
    const error = objectRecord(body?.error);
    if (typeof error?.status === 'string' && /^[A-Z_]{1,64}$/.test(error.status)) reason = error.status;
    retryAfterMs = quotaRetryDelay(error, response.headers.get('retry-after'));
    const reset = retryAfterMs === undefined ? '' : ` Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`;
    throw new AntigravityError(`Antigravity inference failed (HTTP ${response.status}${reason ? `, ${reason}` : ''}).${reset}`, response.status, reason, retryAfterMs);
  }
  return response;
}

export function createAntigravityFetch(input: {
  resolveAuth: () => Promise<AntigravityAuthSnapshot>;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  return async (resource, init) => {
    const request = new Request(resource, init);
    const operation = sdkOperation(request);
    request.signal.throwIfAborted();
    const auth = await input.resolveAuth();
    assertAntigravityBillingAllowed(auth.accountId);
    const content = await readGoogleJson(new Response(request.body), 8 * 1024 * 1024);
    const sessionId = request.headers.get(ANTIGRAVITY_SESSION_HEADER) ?? randomUUID();
    const codec = createAntigravitySignatureCodec({ accountId: auth.accountId, sessionId });
    const envelope = buildAntigravityEnvelope({
      ...operation, projectId: auth.projectId,
      sessionId, request: restoreAntigravityToolParts(content, codec),
    });
    const operationName = operation.streaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const response = await (input.fetchImpl ?? globalThis.fetch)(`${ANTIGRAVITY_ORIGIN}/v1internal:${operationName}`, {
      method: 'POST', signal: request.signal, redirect: 'manual', body: JSON.stringify(envelope),
      headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json', 'user-agent': 'antigravity' },
    });
    const observe = (payload: Record<string, unknown>) => {
      recordAntigravityCreditConsumption(auth.accountId, payload);
      recordAntigravityCreditConsumption(auth.accountId, payload.response);
      assertAntigravityBillingAllowed(auth.accountId);
    };
    return unwrapAntigravityResponse(await subscriptionResponse(response, observe), observe, payload => persistAntigravityToolParts(payload, codec));
  };
}
