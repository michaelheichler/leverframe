import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { sockets } = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

class FakeSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
  constructor() { super(); sockets.push(this); }
}

vi.mock('ws', () => ({ WebSocket: FakeSocket, default: FakeSocket }));

import { createResponsesWebSocketFetch, resetResponsesWebSocketConnectionsForTests } from '../src/oauth/responses-websocket.js';

afterEach(() => { resetResponsesWebSocketConnectionsForTests(); sockets.length = 0; });

type Frame = Record<string, unknown>;

async function streamTerminal(frame: Frame): Promise<{ response: Response; diagnostics: Frame[] }> {
  const diagnostics: Frame[] = [];
  const wsFetch = createResponsesWebSocketFetch('wss://models.example.test/responses', undefined, {
    eagerResponseForTests: true, maxTransportRetries: 0, onDiagnostic: event => diagnostics.push(event),
  });
  const response = await wsFetch('https://models.example.test/responses', {
    method: 'POST', body: JSON.stringify({ model: 'test-model', input: [] }),
  });
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify(frame)));
  return { response, diagnostics };
}

function codexTerminal(status: string): Frame {
  return {
    type: `response.${status}`,
    response: {
      id: 'private-response-id', status,
      output: [{ type: 'reasoning', encrypted_content: 'private-content' }],
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : undefined,
      usage: { input_tokens: 115_000, output_tokens: 100, output_tokens_details: { reasoning_tokens: 100 } },
    },
  };
}

function expectContentFreeTerminalDiagnostic(diagnostics: Frame[], status: string): void {
  expect(diagnostics).toContainEqual(expect.objectContaining({
    event: 'ws_response_terminal', upstreamEventType: `response.${status}`,
    responseStatus: status, outputItemCount: 1, reasoningTokens: 100,
  }));
  expect(JSON.stringify(diagnostics)).not.toContain('private-content');
  expect(JSON.stringify(diagnostics)).not.toContain('private-response-id');
}

function sseFrames(body: string): unknown[] {
  return body.split('\n\n').filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));
}

async function readFailure(response: Response): Promise<Error> {
  return response.text().then(
    () => new Error('expected the response body read to reject'),
    (error: unknown) => error as Error,
  );
}

describe('WebSocket terminal diagnostics', () => {
  it.each(['completed', 'incomplete'])('records %s status and output counts without content', async status => {
    const { response, diagnostics } = await streamTerminal(codexTerminal(status));
    await response.text();
    expectContentFreeTerminalDiagnostic(diagnostics, status);
  });

  it('records failed status and output counts without content when the Codex failed frame errors the stream', async () => {
    const { response, diagnostics } = await streamTerminal(codexTerminal('failed'));
    await expect(response.text()).rejects.toMatchObject({ name: 'ProviderTransportError' });
    expectContentFreeTerminalDiagnostic(diagnostics, 'failed');
  });
});

describe('WebSocket terminal frames before any output', () => {
  it('fails a Codex response.failed without sequence_number and keeps the upstream reason', async () => {
    const { response } = await streamTerminal({
      type: 'response.failed',
      response: { id: 'resp_failed', status: 'failed', error: { code: 'server_error', message: 'backend exploded' } },
    });
    const error = await readFailure(response);
    expect(error).toMatchObject({ name: 'ProviderTransportError', httpStatus: 502 });
    expect(error.message).toContain('response.failed');
    expect(error.message).toContain('backend exploded');
  });

  it('fails a response.completed with null usage and names the terminal type', async () => {
    const { response } = await streamTerminal({
      type: 'response.completed', response: { id: 'resp_null_usage', status: 'completed', usage: null },
    });
    await expect(response.text()).rejects.toThrow('response.completed');
  });

  it.each([
    ['response.failed with a sequence_number', {
      type: 'response.failed', sequence_number: 3,
      response: { id: 'resp_failed', status: 'failed', error: { code: 'server_error', message: 'backend exploded' } },
    }],
    ['response.incomplete with valid usage', {
      type: 'response.incomplete',
      response: {
        id: 'resp_incomplete', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 1_000, output_tokens: 64 },
      },
    }],
  ])('passes a well-formed %s through to the SDK unchanged', async (_name, frame) => {
    const { response } = await streamTerminal(frame);
    expect(sseFrames(await response.text())).toEqual([frame]);
  });
});
