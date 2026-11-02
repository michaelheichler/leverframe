import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  RECOVERY_COOLDOWN_MS,
  confirmRecovery,
  recordObservation,
  releaseReservation,
  reserveAccount,
  type PoolKey,
  type ReserveResult,
  type Reservation,
} from '../src/account-pool.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';
import { messageResponse, quotaResponse, startNativeUpstream } from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let previousAlpha: string | undefined;

function pool(): PoolKey {
  return { providerId: 'anthropic-api', modelId: 'model-fixture', billingType: 'api' };
}

function reservation(result: ReserveResult): Reservation {
  if (result.kind !== 'reserved') throw new Error('Expected an account reservation');
  return result.reservation;
}

function route(upstreamUrl: string): ProxyRoute {
  return {
    aliasId: 'anthropic-api__claude-native-fixture', realModelId: 'claude-native-fixture',
    displayName: 'Native fixture model', upstreamUrl, apiKey: 'route-snapshot-credential',
    modelFormat: 'anthropic', npm: '@ai-sdk/anthropic', providerId: 'anthropic-api', authType: 'api',
  };
}

function saveSingleAccount(): void {
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
      authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-01-01',
      accounts: [{ id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true }],
    }],
  });
}

function postMessages(port: number, token: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    model: 'anthropic-api__claude-native-fixture', max_tokens: 20,
    messages: [{ role: 'user', content: 'fixture request' }], stream: false,
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-recovery-'));
  previousHome = process.env.LEVERFRAME_HOME;
  previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-local-credential';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  rmSync(home, { recursive: true, force: true });
});

it('uses a successful unknown-reset probe for the immediate follow-up request', async () => {
  saveSingleAccount();
  let now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let calls = 0;
  const upstream = await startNativeUpstream((_call, response) => {
    calls += 1;
    if (calls === 1) quotaResponse(response, null);
    else messageResponse(response);
  });
  const proxy = await startProxyCatalog([route(`http://127.0.0.1:${upstream.port}`)], 'anthropic-api__claude-native-fixture');

  try {
    const rejected = await postMessages(proxy.port, proxy.token);
    now += 60_000;
    const probe = await postMessages(proxy.port, proxy.token);
    const followup = await postMessages(proxy.port, proxy.token);

    expect(rejected.status).toBe(429);
    expect(probe.status).toBe(200);
    expect(followup.status).toBe(200);
    expect(calls).toBe(3);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('keeps a newer rejection after an older recovery probe succeeds', async () => {
  const poolKey = pool();
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  const accounts = [{ id: 'alpha', enabled: true }];
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      observedAt: 100, status: 'rate_limited',
    },
    now: 100,
  });
  const probe = reservation(await reserveAccount({
    pool: poolKey, accounts, balancing: false, now: probeTime,
  }));
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      observedAt: probeTime + 1, status: 'rate_limited',
    },
    now: probeTime + 1,
  });

  await confirmRecovery({ pool: poolKey, reservationId: probe.id, now: probeTime + 2 });
  await releaseReservation({ pool: poolKey, reservationId: probe.id, now: probeTime + 2 });
  const nextRequest = await reserveAccount({
    pool: poolKey, accounts, balancing: false, now: probeTime + 2,
  });

  expect(nextRequest).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it('recovers an account scoped billing rejection after a successful held probe', async () => {
  const poolKey = pool();
  const accounts = [{ id: 'alpha', enabled: true }];
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'account' }, source: 'anthropic:billing',
      observedAt: 100, status: 'exhausted',
    },
    now: 100,
  });
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  const probe = reservation(await reserveAccount({ pool: poolKey, accounts, balancing: false, now: probeTime }));

  await confirmRecovery({ pool: poolKey, reservationId: probe.id, now: probeTime + 1 });
  await releaseReservation({ pool: poolKey, reservationId: probe.id, now: probeTime + 1 });
  const nextRequest = await reserveAccount({ pool: poolKey, accounts, balancing: false, now: probeTime + 1 });

  expect(nextRequest.kind).toBe('reserved');
});

it('leaves independently dimensioned capacity blocked after generic recovery', async () => {
  const poolKey = pool();
  const probeTime = 101 + RECOVERY_COOLDOWN_MS;
  const accounts = [{ id: 'alpha', enabled: true }];
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      observedAt: 100, status: 'rate_limited',
    },
    now: 100,
  });
  const probe = reservation(await reserveAccount({
    pool: poolKey, accounts, balancing: false, now: probeTime,
  }));
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:capacity',
      dimension: 'requests', observedAt: probeTime, status: 'rate_limited',
    },
    now: probeTime,
  });

  await confirmRecovery({ pool: poolKey, reservationId: probe.id, now: probeTime + 1 });
  await releaseReservation({ pool: poolKey, reservationId: probe.id, now: probeTime + 1 });
  const nextRequest = await reserveAccount({
    pool: poolKey, accounts, balancing: false, now: probeTime + 1,
  });

  expect(nextRequest).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it('does not let an older nonprobe success clear a later rejection', async () => {
  const poolKey = pool();
  const accounts = [{ id: 'alpha', enabled: true }];
  const earlier = reservation(await reserveAccount({ pool: poolKey, accounts, balancing: false, now: 100 }));
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      observedAt: 101, status: 'rate_limited',
    },
    now: 101,
  });

  await confirmRecovery({ pool: poolKey, reservationId: earlier.id, now: 102 });
  await releaseReservation({ pool: poolKey, reservationId: earlier.id, now: 102 });
  const probeTime = 101 + RECOVERY_COOLDOWN_MS;
  const probe = reservation(await reserveAccount({ pool: poolKey, accounts, balancing: false, now: probeTime }));
  await releaseReservation({ pool: poolKey, reservationId: probe.id, now: probeTime });
  const nextRequest = await reserveAccount({ pool: poolKey, accounts, balancing: false, now: probeTime });

  expect(nextRequest).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it('preserves remaining-capacity ranking after generic recovery', async () => {
  const poolKey = pool();
  const accounts = [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }];
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:capacity',
      dimension: 'requests', observedAt: 100, status: 'healthy',
      remaining: { value: 3, unit: 'requests' },
    },
    now: 100,
  });
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'beta', scope: { kind: 'pool' }, source: 'anthropic:capacity',
      dimension: 'requests', observedAt: 100, status: 'healthy',
      remaining: { value: 9, unit: 'requests' },
    },
    now: 100,
  });
  await recordObservation({
    pool: poolKey,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      observedAt: 101, status: 'rate_limited',
    },
    now: 101,
  });
  const probeTime = 101 + RECOVERY_COOLDOWN_MS;
  const probe = reservation(await reserveAccount({
    pool: poolKey, accounts, balancing: false, pinnedAccountId: 'alpha', now: probeTime,
  }));

  await confirmRecovery({ pool: poolKey, reservationId: probe.id, now: probeTime + 1 });
  await releaseReservation({ pool: poolKey, reservationId: probe.id, now: probeTime + 1 });
  const nextRequest = await reserveAccount({ pool: poolKey, accounts, balancing: true, now: probeTime + 2 });

  expect(reservation(nextRequest).accountId).toBe('beta');
});
