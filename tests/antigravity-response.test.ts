import { describe, expect, it } from 'vitest';
import { unwrapAntigravityResponse } from '../src/antigravity/response.js';

describe('Antigravity response translation', () => {
  it('unwraps a JSON result without changing provider content or usage', async () => {
    const body = {
      candidates: [{
        content: { role: 'model', parts: [{ text: 'hello' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
    };
    const response = Response.json({ response: body, traceId: 'request-trace' });

    const translated = unwrapAntigravityResponse(response);

    expect(await translated.json()).toEqual(body);
    expect(translated.status).toBe(200);
  });

  it('unwraps SSE response envelopes across arbitrary byte boundaries', async () => {
    const first = new TextEncoder().encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"grüße"}]}}]}}\n\n');
    const second = new TextEncoder().encode('data: [DONE]\n\n');
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    const split = first.findIndex(byte => byte >= 0x80);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split + 1));
        controller.enqueue(bytes.slice(split + 1, first.length + 4));
        controller.enqueue(bytes.slice(first.length + 4));
        controller.close();
      },
    });

    const translated = unwrapAntigravityResponse(new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const text = await translated.text();
    const events = text.split('\n\n').filter(Boolean).map(frame => frame.replace(/^data:\s*/, ''));

    expect(JSON.parse(events[0]!)).toEqual({ candidates: [{ content: { parts: [{ text: 'grüße' }] } }] });
    expect(events[1]).toBe('[DONE]');
  });

  it('keeps SSE comments and non-data fields out of the Google event stream', async () => {
    const upstream = new Response([
      ': upstream keepalive',
      'event: message',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });

    const translated = unwrapAntigravityResponse(upstream);

    expect(await translated.text()).toBe('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
  });

});

describe('Antigravity streamed response errors', () => {
  it('propagates quota status from a streamed response envelope', async () => {
    const upstream = new Response('data: {"response":{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });

    const translated = unwrapAntigravityResponse(upstream);

    await expect(translated.text()).rejects.toMatchObject({ statusCode: 429 });
  });

  it('rejects malformed SSE response data instead of returning partial output', async () => {
    const upstream = new Response('data: {invalid json}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });

    const translated = unwrapAntigravityResponse(upstream);

    await expect(translated.text()).rejects.toThrow(/stream|invalid/i);
  });

  it('rejects an SSE event that exceeds the response size limit', async () => {
    const upstream = new Response(`data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });

    const translated = unwrapAntigravityResponse(upstream);

    await expect(translated.text()).rejects.toThrow(/size limit/i);
  });
});
