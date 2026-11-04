import * as http from 'node:http';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createRequestExecutionContext } from '../src/request-execution-context.js';
import { finishRoutingNativeRejection, routingNativeFailure } from '../src/routing-native-outcome.js';
import type { ProxyMessageContext } from '../src/proxy-message-context.js';
import type { RequestExecutionSnapshot } from '../src/request-execution-context.js';

const clearSnapshot: RequestExecutionSnapshot = {
  state: 'connecting', isTerminal: false, outputEmitted: false, toolCallEmitted: false,
};

it.each([
  { status: 401, body: '', expected: { reason: 'credential_rejected', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { status: 429, body: JSON.stringify({ error: { type: 'rate_limit_error' } }),
    expected: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { status: 429, body: JSON.stringify({ error: { type: 'insufficient_quota' } }),
    expected: { reason: 'credit_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { status: 402, body: JSON.stringify({ error: { type: 'billing_error' } }),
    expected: { reason: 'credit_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { status: 500, body: JSON.stringify({ error: { type: 'server_error' } }), expected: undefined },
])('classifies only confirmed native availability and billing rejections', ({ status, body, expected }) => {
  const response = { headersSent: false, destroyed: false, writableEnded: false } as ServerResponse;
  const rejection = { status, body, headers: new Headers() };

  expect(routingNativeFailure(rejection, response, clearSnapshot, new AbortController().signal,
    'fixture-provider')).toEqual(expected);
});

it.each([
  { response: { headersSent: true, destroyed: false, writableEnded: false }, snapshot: clearSnapshot, signal: new AbortController().signal },
  { response: { headersSent: false, destroyed: true, writableEnded: false }, snapshot: clearSnapshot, signal: new AbortController().signal },
  { response: { headersSent: false, destroyed: false, writableEnded: true }, snapshot: clearSnapshot, signal: new AbortController().signal },
  { response: { headersSent: false, destroyed: false, writableEnded: false },
    snapshot: { ...clearSnapshot, outputEmitted: true }, signal: new AbortController().signal },
  { response: { headersSent: false, destroyed: false, writableEnded: false },
    snapshot: { ...clearSnapshot, toolCallEmitted: true }, signal: new AbortController().signal },
  { response: { headersSent: false, destroyed: false, writableEnded: false }, snapshot: clearSnapshot, signal: AbortSignal.abort() },
])('does not authorize replay after downstream commitment or cancellation', ({ response, snapshot, signal }) => {
  expect(routingNativeFailure({ status: 401, body: '', headers: new Headers() }, response as ServerResponse,
    snapshot, signal, 'fixture-provider')).toBeUndefined();
});

it('preserves an unclassified upstream status and body for the client', async () => {
  const server = http.createServer((request, response) => {
    const requestExecution = createRequestExecutionContext({ requestId: 'native-outcome-fixture', provider: 'fixture-provider' });
    const state = { res: response, providerId: 'fixture-provider', clientAbort: new AbortController(), requestExecution } as unknown as ProxyMessageContext;
    finishRoutingNativeRejection({ status: 500, body: 'upstream response body', headers: new Headers({ 'content-type': 'text/plain' }) }, state);
    requestExecution.dispose();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: address.port, path: '/', agent: false }, result => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode ?? 0, body }));
    }).on('error', reject);
  });

  expect(response).toEqual({ status: 500, body: 'upstream response body' });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('does not overwrite a response that already ended before rejection handling', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(202, { 'content-type': 'text/plain' });
    response.end('existing response');
    const requestExecution = createRequestExecutionContext({ requestId: 'native-outcome-fixture', provider: 'fixture-provider' });
    const state = { res: response, providerId: 'fixture-provider', clientAbort: new AbortController(), requestExecution } as unknown as ProxyMessageContext;
    finishRoutingNativeRejection({ status: 401, body: 'replacement response', headers: new Headers() }, state);
    requestExecution.dispose();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: address.port, path: '/', agent: false }, result => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode ?? 0, body }));
    }).on('error', reject);
  });

  expect(response).toEqual({ status: 202, body: 'existing response' });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('does not replace headers already committed to the client', async () => {
  const server = http.createServer((request, response) => {
    const requestExecution = createRequestExecutionContext({ requestId: 'native-outcome-fixture', provider: 'fixture-provider' });
    const state = { res: response, providerId: 'fixture-provider', clientAbort: new AbortController(), requestExecution } as unknown as ProxyMessageContext;
    response.writeHead(202, { 'content-type': 'text/plain', 'content-length': '12' });
    response.flushHeaders();
    finishRoutingNativeRejection({ status: 401, body: 'replacement', headers: new Headers() }, state);
    requestExecution.dispose();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const response = await new Promise<{ status: number; body: string; aborted: boolean }>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: address.port, path: '/', agent: false }, result => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', chunk => { body += chunk; });
      result.on('aborted', () => resolve({ status: result.statusCode ?? 0, body, aborted: true }));
      result.on('end', () => resolve({ status: result.statusCode ?? 0, body, aborted: false }));
    }).on('error', reject);
  });

  expect(response).toEqual({ status: 202, body: '', aborted: true });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('leaves an aborted client response untouched', async () => {
  const server = http.createServer((request, response) => {
    const clientAbort = new AbortController();
    clientAbort.abort();
    const requestExecution = createRequestExecutionContext({ requestId: 'native-outcome-fixture', provider: 'fixture-provider' });
    const state = { res: response, providerId: 'fixture-provider', clientAbort, requestExecution } as unknown as ProxyMessageContext;
    finishRoutingNativeRejection({ status: 401, body: 'replacement response', headers: new Headers() }, state);
    response.writeHead(204);
    response.end();
    requestExecution.dispose();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: address.port, path: '/', agent: false }, result => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode ?? 0, body }));
    }).on('error', reject);
  });

  expect(response).toEqual({ status: 204, body: '' });
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('does not write to a response that was destroyed by the client', async () => {
  let closed!: (state: { destroyed: boolean; writeErrors: number }) => void;
  const responseClosed = new Promise<{ destroyed: boolean; writeErrors: number }>(resolve => { closed = resolve; });
  const server = http.createServer((request, response) => {
    let writeErrors = 0;
    response.on('error', () => { writeErrors += 1; });
    response.once('close', () => closed({ destroyed: response.destroyed, writeErrors }));
    response.destroy();
    const requestExecution = createRequestExecutionContext({ requestId: 'native-outcome-fixture', provider: 'fixture-provider' });
    const state = { res: response, providerId: 'fixture-provider', clientAbort: new AbortController(), requestExecution } as unknown as ProxyMessageContext;
    finishRoutingNativeRejection({ status: 401, body: 'replacement response', headers: new Headers() }, state);
    requestExecution.dispose();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as import('node:net').AddressInfo;
  const clientClosed = new Promise<void>(resolve => {
    http.get({ hostname: '127.0.0.1', port: address.port, path: '/', agent: false }).on('error', () => resolve());
  });
  const state = await responseClosed;
  await clientClosed;

  expect(state).toEqual({ destroyed: true, writeErrors: 0 });
  await new Promise<void>(resolve => server.close(() => resolve()));
});
