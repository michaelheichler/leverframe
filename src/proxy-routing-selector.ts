import { ANTHROPIC_API_ORIGIN } from './constants.js';
import type { ProxyHandle } from './proxy.js';
import { httpProxyModelId } from './http-proxy/routes.js';
import type { SelectorCallContext, SelectorDependencies, SelectorPayload } from './routing-selector.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { ClaudeCodeCredentialReader } from './claude-code-credentials.js';
import { anthropicUpstreamHeaders } from './upstream-forward.js';
import { SELECTOR_ATTEMPT_HEADER, SELECTOR_SESSION_HEADER, SELECTOR_CONSUMER_HEADER, SELECTOR_CONNECTION_HEADER } from './routing-selector-attempt.js';
import type { RoutingNoticeChannel } from './routing-notice-channel.js';
import type { ModelRef } from './model-routing.js';
import { observeJsonResponseUsage } from './http-proxy/response-usage.js';
import { encodeSelectorTrace, SELECTOR_TRACE_HEADER, selectorCostSnapshot, writeSelectorTrace, type SelectorTrace } from './routing-selector-log.js';

async function readSelectorResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Routing selector returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) throw new Error('Routing selector response exceeded its limit.');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface SelectorNativeOptions {
  catalog: RoutingCatalogSnapshot; origin: URL; readAuth: ClaudeCodeCredentialReader; fetch?: typeof fetch;
  noticeChannel?: RoutingNoticeChannel; inferenceLogPath?: string;
}

export function createRoutingSelectorCall(adapter: () => ProxyHandle | null, native?: SelectorNativeOptions): SelectorDependencies['call'] {
  return (target, payload, signal, notice, trace) => {
    if (trace) writeSelectorTrace(native?.inferenceLogPath, trace, 'attempt', { target });
    return executeSelectorCall(adapter, native, target, payload, signal, notice, trace).catch(error => {
      if (trace) writeSelectorTrace(native?.inferenceLogPath, trace, 'failed', { target });
      throw error;
    });
  };
}

async function executeSelectorCall(adapter: () => ProxyHandle | null, native: SelectorNativeOptions | undefined,
  target: ModelRef, payload: SelectorPayload, signal: AbortSignal, notice?: SelectorCallContext, trace?: SelectorTrace): Promise<ModelRef> {
    if (signal.aborted) throw new Error('Routing selector was cancelled.');
    const serialized = JSON.stringify(payload);
    if (!Number.isSafeInteger(payload.maxOutputTokens) || payload.maxOutputTokens < 1 || payload.maxOutputTokens > 8192
      || Buffer.byteLength(serialized) > 65_536) throw new Error('Routing selector request exceeds its limit.');
    const nativeModel = native?.catalog.models.find(model => model.ref.providerId === target.providerId
      && model.ref.modelId === target.modelId && model.credential.source === 'claude-code'
      && model.credential.available && model.discovery.confirmed && model.discovery.state === 'current');
    if (nativeModel && native!.origin.href !== new URL(ANTHROPIC_API_ORIGIN).href) {
      throw new Error('Native selector origin changed.');
    }
    const auth = nativeModel ? await native!.readAuth() : undefined;
    if (nativeModel && (!auth || !nativeModel.upstreamModelId)) throw new Error('Native selector credentials or model are unavailable.');
    if (notice) {
      const current = native?.noticeChannel?.capture(notice.sessionId);
      if (notice.signal.aborted || !current || current.signal !== notice.signal
        || current.consumerId !== notice.consumerId || current.connectionId !== notice.connectionId) {
        throw new Error('Routing selector notice consumer is unavailable.');
      }
    }
    const proxy = nativeModel ? null : adapter();
    if (!nativeModel && !proxy) throw new Error('Routing selector adapter is unavailable.');
    const url = nativeModel ? new URL('/v1/messages', native!.origin).toString() : `http://127.0.0.1:${proxy!.port}/v1/messages`;
    const headers = nativeModel && auth ? anthropicUpstreamHeaders(auth.token, false,
      auth.kind === 'oauth' ? 'oauth-2025-04-20' : undefined, auth.kind === 'oauth' ? 'oauth' : 'api')
      : { 'content-type': 'application/json', 'x-api-key': proxy!.token, [SELECTOR_ATTEMPT_HEADER]: '1',
        ...(notice ? { [SELECTOR_SESSION_HEADER]: Buffer.from(notice.sessionId, 'utf8').toString('base64url'),
          [SELECTOR_CONSUMER_HEADER]: notice.consumerId, [SELECTOR_CONNECTION_HEADER]: notice.connectionId } : {}),
        ...(trace ? { [SELECTOR_TRACE_HEADER]: encodeSelectorTrace(trace), 'x-relay-request-id': trace.requestId } : {}) };
    if (signal.aborted || notice?.signal.aborted) throw new Error('Routing selector was cancelled.');
    if (nativeModel && trace) writeSelectorTrace(native?.inferenceLogPath, trace, 'send', { target });
    const response = await (nativeModel ? native?.fetch ?? fetch : fetch)(url, {
      method: 'POST', signal: notice ? AbortSignal.any([signal, notice.signal]) : signal, redirect: 'error',
      headers,
      body: JSON.stringify({ model: nativeModel?.upstreamModelId ?? httpProxyModelId(target.providerId, target.modelId), stream: false,
        max_tokens: payload.maxOutputTokens,
        system: 'Select one candidate. Return only JSON with providerId and modelId. Do not generate code.',
        messages: [{ role: 'user', content: serialized }] }),
    });
    if (!response.ok) throw new Error(`Routing selector failed with status ${response.status}.`);
    const result = await readSelectorResponse(response);
    if (nativeModel && trace && native) observeJsonResponseUsage(result, usage =>
      writeSelectorTrace(native.inferenceLogPath, trace, 'usage', { target, snapshot: selectorCostSnapshot(native.catalog, target), usage }));
    if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
      throw new Error('Routing selector returned an invalid response.');
    }
    const text = result.content.find(item => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')?.text;
    if (typeof text !== 'string' || text.length > 8192) throw new Error('Routing selector returned an invalid response.');
    const selected: unknown = JSON.parse(text);
    if (!selected || typeof selected !== 'object' || !('providerId' in selected) || !('modelId' in selected)
      || typeof selected.providerId !== 'string' || typeof selected.modelId !== 'string') {
      throw new Error('Routing selector returned an invalid response.');
    }
    return { providerId: selected.providerId, modelId: selected.modelId };
}
