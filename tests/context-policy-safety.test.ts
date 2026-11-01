import { expect, it } from 'vitest';
import { applyRequestContextPolicy } from '../src/context/request-policy.js';

const sessionId = 'eligible-session';
const routeIdentity = 'provider:model';
const contextWindow = 96_000;

function requestWith(messages: unknown[], extra: Record<string, unknown> = {}) {
  return { model: 'fixture-model', messages, ...extra };
}

it.each([
  ['session is absent', { sessionId: undefined, contextWindow, request: requestWith([{ role: 'user', content: 'hello' }]) }],
  ['context window is unconfirmed', { sessionId, contextWindow: undefined, request: requestWith([{ role: 'user', content: 'hello' }]) }],
  ['message contains a malformed block', { sessionId, contextWindow, request: requestWith([{ role: 'user', content: [{ text: 'missing type' }] }]) }],
  ['tool call has no result', { sessionId, contextWindow, request: requestWith([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }] }]) }],
])('preserves history when %s', async (_name, input) => {
  const signal = new AbortController().signal;
  const result = await applyRequestContextPolicy({ ...input, routeIdentity, signal });

  expect(result.request).toBe(input.request);
  expect(result.outcome).toBe('unchanged');
  expect(result.estimatedInputTokens).toBeUndefined();
});

it.each([
  ['signed thinking is present', requestWith([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'retain this signed thought privately', signature: 'signed-state' }] }]), 'retain this signed thought privately'],
  ['client context management is present', requestWith([{ role: 'user', content: 'retain this client message privately' }], { context_management: [{ type: 'clear_tool_uses_20250919' }] }), 'retain this client message privately'],
])('preserves provider-managed history when %s', async (_name, request, privateText) => {
  const result = await applyRequestContextPolicy({
    request,
    sessionId,
    routeIdentity,
    contextWindow,
    signal: new AbortController().signal,
  });

  expect(result.request).toBe(request);
  expect(result.outcome).toBe('unsupported_policy');
  expect(result.reason).toBeTruthy();
  expect(result.reason).not.toContain(privateText);
});

it('reports an input estimate separately for eligible history', async () => {
  const request = requestWith([{ role: 'user', content: 'A short coding task.' }]);
  const result = await applyRequestContextPolicy({
    request,
    sessionId,
    routeIdentity,
    contextWindow,
    signal: new AbortController().signal,
  });

  expect(result.request).toBe(request);
  expect(result.outcome).toBe('unchanged');
  expect(result.estimatedInputTokens).toBeGreaterThan(0);
});
