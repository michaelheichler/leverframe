import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { classifyPoolFailure } from '../src/account-pool-dispatch.js';
import { recordObservation, reserveAccount, type PoolKey } from '../src/account-pool.js';

const transientBodies = [
  { error: { message: 'authentication failed (status=503): {"error":"Too many concurrent requests"}', type: 'authentication_error' } },
  { error: { message: 'authentication failed (status=502): upstream temporarily unavailable', type: 'authentication_error' } },
  { error: { message: 'Too many concurrent requests', type: 'authentication_error' } },
];

async function transientRejection(body: (typeof transientBodies)[number]) {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  if (!home) throw new Error('isolated test home is missing');
  const statePath = join(home, `transient-auth-${randomUUID()}.json`);
  const pool: PoolKey = { providerId: 'openai-oauth', modelId: 'retry-fixture', billingType: 'oauth' };
  const now = 1_800_000_000_000;
  const observation = classifyPoolFailure({ provider: pool.providerId, accountId: 'only', statusCode: 401, body, now });
  if (!observation) throw new Error('transient authentication failure needs a retryable observation');
  await recordObservation({ pool, observation, now, statePath });
  return { pool, statePath, now };
}

it.each(transientBodies)('allows an unchanged credential to retry after a transient authentication service failure: %j', async body => {
  const { pool, statePath, now } = await transientRejection(body);

  const result = await reserveAccount({ pool, statePath, now: now + 5 * 60_000, balancing: false,
    accounts: [{ id: 'only', enabled: true }] });

  expect(result.kind).toBe('reserved');
});

it.each(transientBodies)('briefly withholds an account without treating a transient service error as a rejected credential: %j', async body => {
  const { pool, statePath, now } = await transientRejection(body);

  const result = await reserveAccount({ pool, statePath, now: now + 1, balancing: false,
    accounts: [{ id: 'only', enabled: true }] });

  expect(result).toMatchObject({ kind: 'exhausted', accounts: [{ status: 'rate_limited' }] });
});
