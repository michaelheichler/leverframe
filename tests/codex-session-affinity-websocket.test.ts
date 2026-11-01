import { EventEmitter } from 'node:events';
import { expect, it, vi, beforeEach } from 'vitest';

const { sockets } = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

class FakeSocket extends EventEmitter {
  options: { headers?: Record<string, string> };
  send = vi.fn();
  close = vi.fn();
  constructor(_url: string, options: { headers?: Record<string, string> }) {
    super();
    this.options = options;
    sockets.push(this);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeSocket, default: FakeSocket }));

import { createResponsesWebSocketFetch, resetResponsesWebSocketConnectionsForTests } from '../src/oauth/responses-websocket.js';

beforeEach(() => {
  resetResponsesWebSocketConnectionsForTests();
  sockets.length = 0;
});

function payload(promptCacheKey: string) {
  return {
    model: 'gpt-5.6-sol', prompt_cache_key: promptCacheKey,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'fixture request' }] }],
  };
}

function complete(socket: FakeSocket, responseId: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: responseId } })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.added', output_index: 0,
    item: { type: 'message', id: `message-${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_text.delta', item_id: `message-${responseId}`, delta: 'fixture response',
  })));
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.output_item.done', output_index: 0,
    item: { type: 'message', id: `message-${responseId}` },
  })));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: responseId } })));
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel();
}

it('isolates overlapping session keys and forwards each affinity header without credentials in the key', async () => {
  const fetch = createResponsesWebSocketFetch('wss://chatgpt.com/backend-api/codex/responses', undefined, {
    providerId: 'openai', accountId: 'fixture-account', maxTransportRetries: 0, eagerResponseForTests: true,
  });
  const firstKey = 'relay-session-first';
  const secondKey = 'relay-session-second';
  const auth = 'Bearer fixture-access-token';
  const first = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', headers: {
      Authorization: auth, 'session-id': firstKey, 'ChatGPT-Account-Id': 'fixture-account',
    }, body: JSON.stringify(payload(firstKey)),
  });
  const firstSocket = sockets[0]!;
  const second = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', headers: {
      Authorization: auth, 'session-id': secondKey, 'ChatGPT-Account-Id': 'fixture-account',
    }, body: JSON.stringify(payload(secondKey)),
  });
  const secondSocket = sockets[1]!;

  expect(sockets).toHaveLength(2);
  expect(firstSocket.options.headers?.['session-id']).toBe(firstKey);
  expect(secondSocket.options.headers?.['session-id']).toBe(secondKey);
  expect(firstSocket.options.headers?.Authorization).toMatch(/^Bearer /);
  expect(secondSocket.options.headers?.Authorization).toMatch(/^Bearer /);
  expect(firstSocket.options.headers?.['ChatGPT-Account-Id']).toBe('fixture-account');
  expect(secondSocket.options.headers?.['ChatGPT-Account-Id']).toBe('fixture-account');

  firstSocket.emit('open');
  secondSocket.emit('open');
  complete(firstSocket, 'first-response');
  complete(secondSocket, 'second-response');
  await Promise.all([drain(first), drain(second)]);
});
