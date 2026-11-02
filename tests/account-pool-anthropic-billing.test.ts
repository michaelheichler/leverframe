import { expect, it } from 'vitest';
import { classifyPoolFailure, poolExhaustionMessage } from '../src/account-pool-dispatch.js';

it('classifies a confirmed provider billing rejection as account scoped exhaustion', () => {
  const result = classifyPoolFailure({
    provider: 'anthropic', accountId: 'fixture-account', statusCode: 402,
    body: { error: { type: 'billing_error' } }, now: 100,
  });

  expect(result).toMatchObject({ accountId: 'fixture-account', scope: { kind: 'account' }, status: 'exhausted' });
});

it('does not infer billing from an ambiguous HTTP 400 response', () => {
  const result = classifyPoolFailure({
    provider: 'anthropic', accountId: 'fixture-account', statusCode: 400,
    body: { error: { type: 'invalid_request_error' } }, now: 100,
  });

  expect(result).toBeUndefined();
});

it('treats HTTP 402 as payment-required billing regardless of vendor error shape', () => {
  const result = classifyPoolFailure({
    provider: 'anthropic', accountId: 'fixture-account', statusCode: 402,
    body: { error: { type: 'invalid_request_error' } }, now: 100,
  });

  expect(result).toMatchObject({
    accountId: 'fixture-account', scope: { kind: 'account' }, status: 'exhausted',
  });
});

it('distinguishes a billing block from a quota reset in pool exhaustion output', () => {
  const billing = poolExhaustionMessage({
    kind: 'exhausted', attempted: ['fixture-account'],
    accounts: [{ accountId: 'fixture-account', status: 'exhausted', reason: 'billing' }],
  });
  const quota = poolExhaustionMessage({
    kind: 'exhausted', attempted: ['fixture-account'],
    accounts: [{ accountId: 'fixture-account', status: 'rate_limited', resetAt: 1_800_000_000_000 }],
  });

  expect(billing).not.toBe(quota);
  expect(billing).toContain('fixture-account');
  expect(billing).not.toContain(new Date(1_800_000_000_000).toISOString());
});
