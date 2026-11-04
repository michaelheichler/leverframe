import { APICallError } from 'ai';
import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import {
  routingSdkFailure,
  routingSdkPoolUnavailable,
  routingSdkPrecommit,
} from '../src/routing-sdk-outcome.js';
import type { RequestExecutionSnapshot } from '../src/request-execution-context.js';

const clearSnapshot: RequestExecutionSnapshot = {
  state: 'connecting', isTerminal: false, outputEmitted: false, toolCallEmitted: false,
};

const classifiedErrors = [
  { error: new APICallError({ message: 'Fixture rejection.', url: 'http://127.0.0.1/v1/messages', requestBodyValues: {},
    statusCode: 401, responseBody: JSON.stringify({ error: { type: 'authentication_error' } }), isRetryable: false }),
    expected: { reason: 'credential_rejected', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { error: new APICallError({ message: 'Fixture rejection.', url: 'http://127.0.0.1/v1/messages', requestBodyValues: {},
    statusCode: 429, responseBody: JSON.stringify({ error: { type: 'rate_limit_error' } }), isRetryable: true }),
    expected: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { error: new APICallError({ message: 'Fixture rejection.', url: 'http://127.0.0.1/v1/messages', requestBodyValues: {},
    statusCode: 429, responseBody: JSON.stringify({ error: { type: 'insufficient_quota' } }), isRetryable: true }),
    expected: { reason: 'credit_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
  { error: new APICallError({ message: 'Fixture rejection.', url: 'http://127.0.0.1/v1/messages', requestBodyValues: {},
    statusCode: 402, responseBody: JSON.stringify({ error: { type: 'billing_error' } }), isRetryable: false }),
    expected: { reason: 'credit_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } },
] as const;

it.each(classifiedErrors)('classifies a confirmed pre-output provider rejection', ({ error, expected }) => {
  const response = { headersSent: false, destroyed: false, writableEnded: false } as ServerResponse;

  expect(routingSdkFailure(error, response, clearSnapshot, new AbortController().signal, 'fixture-provider')).toEqual(expected);
});

it.each([
  new APICallError({ message: 'Fixture transient failure.', url: 'http://127.0.0.1/v1/messages', requestBodyValues: {},
    statusCode: 500, responseBody: JSON.stringify({ error: { type: 'server_error' } }), isRetryable: true }),
  new Error('socket closed before response headers'),
  { statusCode: 401, message: 'not an SDK API error' },
])('does not classify an ambiguous or transient SDK failure as safe fallback evidence', error => {
  const response = { headersSent: false, destroyed: false, writableEnded: false } as ServerResponse;

  expect(routingSdkFailure(error, response, clearSnapshot, new AbortController().signal, 'fixture-provider')).toBeUndefined();
});

it.each([
  { headersSent: true, destroyed: false, writableEnded: false, snapshot: clearSnapshot, signal: new AbortController().signal },
  { headersSent: false, destroyed: true, writableEnded: false, snapshot: clearSnapshot, signal: new AbortController().signal },
  { headersSent: false, destroyed: false, writableEnded: true, snapshot: clearSnapshot, signal: new AbortController().signal },
  { headersSent: false, destroyed: false, writableEnded: false,
    snapshot: { ...clearSnapshot, outputEmitted: true }, signal: new AbortController().signal },
  { headersSent: false, destroyed: false, writableEnded: false,
    snapshot: { ...clearSnapshot, toolCallEmitted: true }, signal: new AbortController().signal },
  { headersSent: false, destroyed: false, writableEnded: false, snapshot: clearSnapshot, signal: AbortSignal.abort() },
])('refuses replay when the downstream request is committed, emitted, or cancelled', state => {
  const response = {
    headersSent: state.headersSent,
    destroyed: state.destroyed,
    writableEnded: state.writableEnded,
  } as ServerResponse;
  expect(routingSdkPrecommit(response, state.snapshot, state.signal)).toBe(false);
  expect(routingSdkFailure(classifiedErrors[0].error,
    response, state.snapshot, state.signal, 'fixture-provider')).toBeUndefined();
});

it.each([
  { accounts: [{ status: 'auth_failure' }, { status: 'auth_failure' }], expected: { reason: 'credential_rejected', acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' } },
  { accounts: [{ status: 'exhausted', reason: 'billing' }, { status: 'exhausted', reason: 'billing' }], expected: { reason: 'credit_exhausted', acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' } },
  { accounts: [{ status: 'rate_limited' }, { status: 'exhausted' }], expected: { reason: 'quota_exhausted', acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' } },
  { accounts: [{ status: 'rate_limited' }, { status: 'healthy' }], expected: undefined },
  { accounts: [{ status: 'unknown' }, { status: 'auth_failure' }], expected: undefined },
  { accounts: [], expected: undefined },
])('uses only a uniform stored pool outcome as safe pre-send evidence', ({ accounts, expected }) => {
  const response = { headersSent: false, destroyed: false, writableEnded: false } as ServerResponse;
  const failure = routingSdkPoolUnavailable(accounts as Array<{ status: string; reason?: 'billing' }>,
    response, clearSnapshot, new AbortController().signal);

  expect(failure).toEqual(expected);
});
