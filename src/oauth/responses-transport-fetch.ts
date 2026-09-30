import type { FetchFunction } from '@ai-sdk/provider-utils';
import { createResponsesWebSocketFetch } from './responses-websocket.js';
import type { ResponsesWebSocketFetchOptions } from './responses-websocket-types.js';

function requestedModel(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function rejectsModel(event: unknown, model: string): boolean {
  if (!event || typeof event !== 'object') return false;
  const record = event as { type?: unknown; error?: { type?: unknown; message?: unknown } };
  return record.type === 'error' && record.error?.type === 'invalid_request_error'
    && record.error.message === `The '${model}' model is not supported when using Codex with a ChatGPT account.`;
}

function inspectEvent(line: string, model: string): 'fallback' | 'keep' | undefined {
  if (!line.startsWith('data: ')) return undefined;
  if (line === 'data: [DONE]') return 'keep';
  let event: { type?: unknown };
  try { event = JSON.parse(line.slice(6)); } catch { return 'keep'; }
  if (rejectsModel(event, model)) return 'fallback';
  const type = event?.type;
  return typeof type === 'string' && /^(?:error$|response\.(?:output|reasoning|completed|failed|incomplete))/.test(type)
    ? 'keep' : undefined;
}

async function needsHttpFallback(response: Response, model: string): Promise<boolean> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return false;
  const reader = response.clone().body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  try {
    while (bytes < 65_536) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) return false;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        const decision = inspectEvent(line.trimEnd(), model);
        if (decision !== undefined) return decision === 'fallback';
      }
    }
    return false;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export function createResponsesTransportFetch(
  wsUrl: string,
  log?: (message: string) => void,
  options: ResponsesWebSocketFetchOptions = {},
): FetchFunction {
  const websocket = createResponsesWebSocketFetch(wsUrl, log, options);
  const http = globalThis.fetch;
  return async (input, init) => {
    const response = await websocket(input, init);
    const model = requestedModel(init?.body);
    if (model === undefined || !await needsHttpFallback(response, model)) return response;
    await response.body!.cancel();
    const headers = new Headers(init?.headers);
    headers.delete('x-openai-internal-codex-responses-lite');
    headers.delete('openai-beta');
    log?.('WebSocket model rejected before output; retrying the same request over HTTP');
    return http(input, { ...init, headers });
  };
}
