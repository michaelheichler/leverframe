import { readGoogleJson } from './http.js';
import { AntigravityError, objectRecord } from './types.js';

const MAX_EVENT_BYTES = 1024 * 1024;
type ObserveResponse = (payload: Record<string, unknown>) => void;
type RewriteResponse = (payload: Record<string, unknown>) => Record<string, unknown>;

function responsePayload(value: unknown, observe?: ObserveResponse, rewrite?: RewriteResponse): Record<string, unknown> {
  const outer = objectRecord(value);
  if (!outer) throw new AntigravityError('Antigravity returned an invalid response envelope.');
  observe?.(outer);
  const body = objectRecord(outer.response) ?? outer;
  if (body !== outer) observe?.(body);
  const error = objectRecord(body.error);
  if (error) {
    const code = typeof error.code === 'number' && error.code >= 400 && error.code <= 599 ? error.code : 502;
    throw new AntigravityError(`Antigravity inference failed (HTTP ${code}).`, code);
  }
  return rewrite ? rewrite(body) : body;
}

function googleEvent(data: string[], observe?: ObserveResponse, rewrite?: RewriteResponse): string {
  const payload = data.join('\n');
  if (payload === '[DONE]') return 'data: [DONE]\n\n';
  try {
    return `data: ${JSON.stringify(responsePayload(JSON.parse(payload), observe, rewrite))}\n\n`;
  } catch (error) {
    if (error instanceof AntigravityError) throw error;
    throw new AntigravityError('Antigravity returned an invalid stream event.');
  }
}

function sseTransform(observe?: ObserveResponse, rewrite?: RewriteResponse): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let pending = '';
  let data: string[] = [];
  let eventBytes = 0;
  const line = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    eventBytes += Buffer.byteLength(text);
    if (eventBytes > MAX_EVENT_BYTES) throw new AntigravityError('Antigravity stream event exceeds the size limit.');
    if (!text) {
      if (data.length) controller.enqueue(encoder.encode(googleEvent(data, observe, rewrite)));
      data = [];
      eventBytes = 0;
    } else if (text.startsWith('data:')) {
      data.push(text.slice(5).replace(/^ /, ''));
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end).replace(/\r$/, ''), controller);
        pending = pending.slice(end + 1);
      }
      if (Buffer.byteLength(pending) + eventBytes > MAX_EVENT_BYTES) throw new AntigravityError('Antigravity stream event exceeds the size limit.');
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) line(pending.replace(/\r$/, ''), controller);
      line('', controller);
    },
  });
}

export function unwrapAntigravityResponse(response: Response, observe?: ObserveResponse, rewrite?: RewriteResponse): Response {
  const streaming = response.headers.get('content-type')?.includes('text/event-stream');
  if (streaming) {
    if (!response.body) throw new AntigravityError('Antigravity returned an empty stream.');
    return new Response(response.body.pipeThrough(sseTransform(observe, rewrite)), {
      status: response.status, headers: { 'content-type': 'text/event-stream' },
    });
  }
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const payload = responsePayload(await readGoogleJson(response), observe, rewrite);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return response.body?.cancel(reason).catch(() => {}); },
  });
  return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
}
