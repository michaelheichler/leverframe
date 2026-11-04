import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { acknowledgeRoutingNotice, advanceRoutingFallback, createRoutingBinding, ensureRoutingLaunchNotices,
  listRoutingNotices, recordRoutingRequestCompletion, resolveRoutingBinding, routingBindingEvents, routingBindingStatePath,
  withRoutingLease } from '../src/routing-bindings.js';
import type { RoutingFallbackInput, RoutingBinding } from '../src/routing-bindings.js';
import { awaitRoutingNotice } from '../src/proxy-routing-control.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const testHome = process.env['LEVERFRAME_TEST_HOME'];
const workload = { input: 120, output: 40, cacheRead: 0, cacheWrite: 0 };
const requirements = { capabilities: [], contextTokens: 1_000 };
const initial = { providerId: 'notice-primary-provider', modelId: 'notice-primary-model' };
const replacement = { providerId: 'notice-replacement-provider', modelId: 'notice-replacement-model' };
const laterReplacement = { providerId: 'notice-later-provider', modelId: 'notice-later-model' };
type NoticeAckBody = { sessionId: string; consumerId: string; sequence: number; modelId: string; revision: number };

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function fixture() {
  const models = [initial, replacement, laterReplacement];
  const catalog = buildRoutingCatalog(input(models.map(ref => provider({
    id: ref.providerId,
    templateId: 'notice-test',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [{
      id: ref.modelId,
      name: ref.modelId,
      upstreamModelId: `upstream-${ref.modelId}`,
      modelFormat: 'anthropic',
      contextWindow: 90_000,
      outputTokenLimit: 12_000,
      supportedReasoningEfforts: ['low'],
    }] },
  })), {
    credentials: models.map(ref => observation(ref.providerId)),
    discovery: models.map(ref => ({ providerId: ref.providerId, status: 'live' as const,
      cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  }));
  const config = { enabled: true, categories: { implementation: { target: initial,
    fallbacks: [replacement, laterReplacement] } } } satisfies RoutingConfig;
  const sessionId = `notice-session-${randomUUID()}`;
  const launchId = `notice-launch-${randomUUID()}`;
  return { catalog, config, sessionId, launchId };
}

async function startControlService(state: ReturnType<typeof fixture>, recoveryOnly = false) {
  return startHttpProxy({ host: '127.0.0.1', port: 0, routes: [],
    routing: { config: recoveryOnly ? { ...state.config, enabled: false, recoveryEnabled: true } : state.config,
      ...(recoveryOnly ? { recoveryOnly: true as const } : {}), catalog: state.catalog, workload } });
}

async function createBinding(state: ReturnType<typeof fixture>) {
  const path = routingBindingStatePath(state.sessionId);
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(path))).toBe(true);
  return createRoutingBinding({ sessionId: state.sessionId, launchId: state.launchId, role: 'specialist',
    category: 'implementation', task: 'Review the accepted change.', config: state.config,
    catalog: state.catalog, workload, requirements });
}

async function createAcknowledgedNoticeHistory(state: ReturnType<typeof fixture>) {
  const binding = await createRoutingBinding({ sessionId: state.sessionId, launchId: `${state.launchId}-history`,
    role: 'specialist', category: 'implementation', task: 'Review the bounded notice history.', config: state.config,
    catalog: state.catalog, workload, requirements, selectorSkipReason: routingBindingEvents.selectorMetadataUnavailable });
  const receipts: Array<{ sequence: number; modelId: string; revision: number }> = [];
  const exhaustionErrors: string[] = [];
  let historySequence = 0;
  let acknowledgedDuringLeaseCount = 0;
  let acknowledgedDuringLeaseBytes = 0;

  await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
    const initialNotices = await ensureRoutingLaunchNotices({ sessionId: state.sessionId, modelId: binding.id,
      leaseId: leased.lease!, revision: leased.revision });
    historySequence = Math.max(...initialNotices.map(notice => notice.sequence));
    await Promise.all(initialNotices.map(notice => acknowledgeRoutingNotice({ sessionId: state.sessionId,
      sequence: notice.sequence, modelId: binding.id, revision: notice.revision })));
    for (let index = 0; index < 65; index++) {
      try {
        await advanceRoutingFallback({ ...transitionInput(leased, leased.lease!, state), candidateAllowed: () => false });
      } catch (error) {
        exhaustionErrors.push((error as { code?: string }).code ?? 'unknown');
      }
      const exhausted = listRoutingNotices(state.sessionId, historySequence)
        .find(notice => 'kind' in notice && notice.kind === 'exhausted' && notice.sequence > historySequence)!;
      historySequence = exhausted.sequence;
      receipts.push({ sequence: exhausted.sequence, modelId: binding.id, revision: exhausted.revision });
    }
    await Promise.all(receipts.map(receipt => acknowledgeRoutingNotice({ sessionId: state.sessionId,
      sequence: receipt.sequence, modelId: receipt.modelId, revision: receipt.revision })));
    const acknowledgedDuringLease = listRoutingNotices(state.sessionId, 0)
      .filter(notice => 'kind' in notice && notice.kind === 'exhausted' && notice.acknowledged);
    acknowledgedDuringLeaseCount = acknowledgedDuringLease.length;
    acknowledgedDuringLeaseBytes = acknowledgedDuringLease.reduce((sum, notice) =>
      sum + Buffer.byteLength(JSON.stringify(notice), 'utf8'), 0);
  });

  await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, leased =>
    ensureRoutingLaunchNotices({ sessionId: state.sessionId, modelId: binding.id,
      leaseId: leased.lease!, revision: leased.revision }));

  return { binding, receipts, exhaustionErrors, acknowledgedDuringLeaseCount, acknowledgedDuringLeaseBytes };
}

function transitionInput(binding: RoutingBinding, leaseId: string, state: ReturnType<typeof fixture>, signal = new AbortController().signal): RoutingFallbackInput {
  return { sessionId: binding.sessionId, modelId: binding.id, leaseId, revision: binding.revision,
    failure: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' },
    catalog: state.catalog, workload, requirements, maxOutputTokens: workload.output,
    deadline: Date.parse(binding.expiresAt), signal };
}

async function requestJson(port: number, method: string, path: string, token: string,
  body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port, method, path,
      headers: { Authorization: `Bearer ${token}`, ...(serialized === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized),
      }), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }); }
        catch { resolve({ status: response.statusCode ?? 0, body: { raw: Buffer.concat(chunks).toString() } }); }
      });
    });
    request.on('error', reject);
    request.end(serialized);
  });
}

async function readNoticeEvent(port: number, sessionId: string, consumerId: string, token: string, after = '0', holdOpen = false) {
  const query = new URLSearchParams({ sessionId, after });
  return new Promise<{ notice: Record<string, unknown>; eventId: string; close: () => void }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'GET',
      path: `/v1/leverframe/routing-events?${query}`, headers: { Authorization: `Bearer ${token}`,
        'x-leverframe-notice-consumer': consumerId } }, response => {
      let content = '';
      response.on('data', chunk => {
        content += Buffer.from(chunk).toString();
        const boundary = /\r?\n\r?\n/.exec(content);
        if (!boundary) return;
        const event = content.slice(0, boundary.index);
        const eventId = /^id:\s*(.+)$/m.exec(event)?.[1];
        const payload = /^data:\s*(.+)$/m.exec(event)?.[1];
        if (!eventId || !payload) return reject(new Error('The notice stream returned an incomplete event.'));
        resolve({ eventId, notice: JSON.parse(payload) as Record<string, unknown>, close: () => request.destroy() });
        if (!holdOpen) request.destroy();
      });
      response.on('end', () => reject(new Error('The notice stream closed before an event arrived.')));
    });
    request.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    request.end();
  });
}

async function registerNoticeConsumer(port: number, sessionId: string, token: string) {
  return requestJson(port, 'POST', '/v1/leverframe/routing-notice-ready', token, { sessionId, protocolVersion: 1 });
}

async function postMalformed(port: number, path: string, token: string, rawBody: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody) } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(rawBody);
  });
}

it('returns a pending notice to the authenticated session consumer without acknowledging its cursor', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const event = await readNoticeEvent(proxy.port, state.sessionId, String(ready.body.consumerId), proxy.token);
      const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });

      expect(ready.status).toBe(200);
      expect(event.eventId).toBe(String(updated.pendingNotice!.sequence));
      expect(event.notice).toMatchObject({ sessionId: state.sessionId, sequence: updated.pendingNotice!.sequence,
        modelId: binding.id, revision: updated.revision, previous: initial, target: replacement, acknowledged: false });
      expect(stored.pendingNotice?.acknowledged).toBe(false);
    });
  } finally {
    await proxy.close();
  }
});

it('renews the active notice consumer without replacing its stream or releasing the pending wait', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const notice = updated.pendingNotice!;
      const controller = new AbortController();
      let waitSettled = false;
      const pendingWait = awaitRoutingNotice({ sessionId: state.sessionId, sequence: notice.sequence,
        modelId: binding.id, revision: updated.revision, leaseId: leased.lease!,
        deadline: Date.parse(binding.expiresAt), signal: controller.signal }).then(
        () => { waitSettled = true; }, () => { waitSettled = true; });
      let stream: Awaited<ReturnType<typeof readNoticeEvent>> | undefined;

      try {
        const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
        const consumerId = String(ready.body.consumerId);
        stream = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token, '0', true);
        const renewed = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ready', proxy.token, {
          sessionId: state.sessionId, protocolVersion: 1, consumerId,
        });
        const afterRenewal = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });

        expect(ready.status).toBe(200);
        expect(stream.notice).toMatchObject({ sessionId: state.sessionId, sequence: notice.sequence,
          modelId: binding.id, revision: updated.revision, acknowledged: false });
        expect(renewed).toMatchObject({ status: 200, body: { consumerId } });
        expect(afterRenewal.pendingNotice?.acknowledged).toBe(false);
        expect(waitSettled).toBe(false);

        const stale = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ready', proxy.token, {
          sessionId: state.sessionId, protocolVersion: 1, consumerId: `${consumerId}-stale`,
        });
        const acknowledged = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
          sessionId: state.sessionId, consumerId, sequence: notice.sequence,
          modelId: binding.id, revision: updated.revision,
        });
        await pendingWait;
        const afterAcknowledgment = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });

        expect(stale.status).toBe(409);
        expect(acknowledged).toMatchObject({ status: 200, body: { acknowledged: true } });
        expect(waitSettled).toBe(true);
        expect(afterAcknowledgment.pendingNotice?.acknowledged).toBe(true);
      } finally {
        controller.abort();
        stream?.close();
        await pendingWait;
      }
    });
  } finally {
    await proxy.close();
  }
});

it('serves notices for a saved job when new routing is disabled', async () => {
  const state = fixture();
  const binding = await createBinding(state);
  const proxy = await startControlService(state, true);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const event = await readNoticeEvent(proxy.port, state.sessionId, String(ready.body.consumerId), proxy.token);

      expect(proxy.routingRecoveryOnly).toBe(true);
      expect(event.notice).toMatchObject({ sessionId: state.sessionId, modelId: binding.id,
        revision: updated.revision, target: replacement, acknowledged: false });
    });
  } finally {
    await proxy.close();
  }
});

it('replays an unacknowledged notice when the consumer reconnects from its last cursor', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const first = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token);
      const reconnected = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const replay = await readNoticeEvent(proxy.port, state.sessionId, String(reconnected.body.consumerId), proxy.token, first.eventId);

      expect(replay.eventId).toBe(first.eventId);
      expect(replay.notice).toMatchObject({ sessionId: state.sessionId, modelId: binding.id,
        sequence: updated.pendingNotice!.sequence, revision: updated.revision, acknowledged: false });
    });
  } finally {
    await proxy.close();
  }
});

it('rejects acknowledgment after the notice stream disconnects', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const notice = updated.pendingNotice!;
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const stream = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token, '0', true);
      stream.close();
      const response = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: notice.sequence,
        modelId: binding.id, revision: updated.revision,
      });
      const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(stored.pendingNotice?.acknowledged).toBe(false);
    });
  } finally {
    await proxy.close();
  }
});

it.each([
  { label: 'session', alter: (body: NoticeAckBody) => ({ ...body, sessionId: `${body.sessionId}-other` }) },
  { label: 'consumer', alter: (body: NoticeAckBody) => ({ ...body, consumerId: `${body.consumerId}-other` }) },
  { label: 'sequence', alter: (body: NoticeAckBody) => ({ ...body, sequence: body.sequence + 1 }) },
  { label: 'binding', alter: (body: NoticeAckBody) => ({ ...body, modelId: `${body.modelId}-other` }) },
  { label: 'revision', alter: (body: NoticeAckBody) => ({ ...body, revision: body.revision + 1 }) },
])('rejects an acknowledgment with the wrong $label identity', async ({ alter }) => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const notice = updated.pendingNotice!;
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const stream = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token, '0', true);
      const identity = { sessionId: state.sessionId, consumerId, sequence: notice.sequence,
        modelId: binding.id, revision: updated.revision };
      const body = alter(identity);
      const response = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, body);
      const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      stream.close();

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(stored.pendingNotice?.acknowledged).toBe(false);
    });
  } finally {
    await proxy.close();
  }
});

it('treats a repeated exact acknowledgment as idempotent', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const notice = updated.pendingNotice!;
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const stream = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token, '0', true);
      const body = { sessionId: state.sessionId, consumerId, sequence: notice.sequence,
        modelId: binding.id, revision: updated.revision };
      const first = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, body);
      const duplicate = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, body);
      const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      stream.close();

      expect(first.body).toMatchObject({ acknowledged: true });
      expect(duplicate.body).toMatchObject({ acknowledged: true });
      expect(stored.pendingNotice?.acknowledged).toBe(true);
      expect(stored.revision).toBe(updated.revision);
    });
  } finally {
    await proxy.close();
  }
});

it('does not let an old exact acknowledgment confirm a later model revision', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const first = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const firstNotice = first.pendingNotice!;
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const stream = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token, '0', true);
      const firstAck = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: firstNotice.sequence,
        modelId: binding.id, revision: first.revision,
      });
      const second = await advanceRoutingFallback(transitionInput(first, leased.lease!, state));
      const oldAck = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: firstNotice.sequence,
        modelId: binding.id, revision: first.revision,
      });
      const current = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      stream.close();

      expect(firstAck.body).toMatchObject({ acknowledged: true });
      expect(oldAck.body).toMatchObject({ acknowledged: true });
      expect(current.decision.target).toEqual(laterReplacement);
      expect(current.revision).toBe(second.revision);
      expect(current.pendingNotice).toMatchObject({ sequence: second.pendingNotice!.sequence,
        revision: second.revision, acknowledged: false });
    });
  } finally {
    await proxy.close();
  }
});

it('releases a notice wait only after an authenticated exact revision acknowledgment', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);
  const abort = new AbortController();

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const notice = updated.pendingNotice!;
      const waiting = awaitRoutingNotice({ sessionId: state.sessionId, sequence: notice.sequence, modelId: binding.id,
        revision: updated.revision, leaseId: leased.lease!, deadline: Date.parse(binding.expiresAt), signal: abort.signal });
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const stream = await readNoticeEvent(proxy.port, state.sessionId, String(ready.body.consumerId), proxy.token, '0', true);
      const response = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId: ready.body.consumerId, sequence: notice.sequence,
        modelId: binding.id, revision: updated.revision,
      });
      const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      stream.close();

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ acknowledged: true });
      expect(stored.pendingNotice?.acknowledged).toBe(true);
      await expect(waiting).resolves.toBeUndefined();
    });
  } finally {
    await proxy.close();
  }
});

it('stops a notice wait when its parent request is already cancelled', async () => {
  const state = fixture();
  const binding = await createBinding(state);
  const abort = new AbortController();

  await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
    const updated = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state, abort.signal));
    abort.abort();
    await expect(awaitRoutingNotice({ sessionId: state.sessionId, sequence: updated.pendingNotice!.sequence,
      modelId: binding.id, revision: updated.revision, leaseId: leased.lease!,
      deadline: Date.parse(binding.expiresAt), signal: abort.signal })).rejects.toThrow();
  });
});

it('authenticates a malformed readiness request before parsing its body', async () => {
  const state = fixture();
  const proxy = await startControlService(state);

  try {
    const status = await postMalformed(proxy.port, '/v1/leverframe/routing-notice-ready', 'invalid-token', '{');

    expect(status).toBe(401);
  } finally {
    await proxy.close();
  }
});

it('registers an authenticated notice consumer for its session', async () => {
  const state = fixture();
  const proxy = await startControlService(state);

  try {
    const response = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);

    expect(response.status).toBe(200);
    expect(response.body.consumerId).toEqual(expect.any(String));
    expect(response.body.expiresAt).toEqual(expect.any(String));
  } finally {
    await proxy.close();
  }
});

it('acknowledging a launch notice leaves the fallback revision and pending acknowledgment unchanged', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const binding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const launchNotices = await ensureRoutingLaunchNotices({ sessionId: state.sessionId, modelId: binding.id,
        leaseId: leased.lease!, revision: leased.revision });
      const launchNotice = launchNotices[0]!;
      const fallback = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const stream = await readNoticeEvent(proxy.port, state.sessionId, String(ready.body.consumerId), proxy.token, '0', true);
      const acknowledgment = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId: String(ready.body.consumerId), sequence: launchNotice.sequence,
        modelId: binding.id, revision: launchNotice.revision,
      });
      const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      stream.close();

      expect(stream.notice).toMatchObject({ kind: 'launch', sequence: launchNotice.sequence, acknowledged: false });
      expect(acknowledgment).toMatchObject({ status: 200, body: { acknowledged: true } });
      expect(stored.revision).toBe(fallback.revision);
      expect(stored.pendingNotice).toMatchObject({ sequence: fallback.pendingNotice!.sequence,
        revision: fallback.revision, acknowledged: false });
      expect(listRoutingNotices(state.sessionId, 0)).toContainEqual(expect.objectContaining({
        kind: 'launch', sequence: launchNotice.sequence, acknowledged: true,
      }));
    });
  } finally {
    await proxy.close();
  }
});

it('retains an acknowledged completion receipt while it remains inside notice history', async () => {
  const state = fixture();
  const binding = await createBinding(state);

  const notices = await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
    const fallback = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
    const launchNotices = await ensureRoutingLaunchNotices({ sessionId: state.sessionId, modelId: binding.id,
      leaseId: leased.lease!, revision: fallback.revision });
    const first = await recordRoutingRequestCompletion({ sessionId: state.sessionId, modelId: binding.id,
      leaseId: leased.lease!, revision: fallback.revision });

    await expect(recordRoutingRequestCompletion({ sessionId: state.sessionId, modelId: binding.id,
      leaseId: leased.lease!, revision: fallback.revision })).rejects.toMatchObject({ code: 'routing_notice_pending' });
    await acknowledgeRoutingNotice({ sessionId: state.sessionId, sequence: first.sequence,
      modelId: binding.id, revision: first.revision });
    const second = await recordRoutingRequestCompletion({ sessionId: state.sessionId, modelId: binding.id,
      leaseId: leased.lease!, revision: fallback.revision });
    return { second, launchSequence: launchNotices[0]!.sequence, fallbackSequence: fallback.pendingNotice!.sequence,
      firstSequence: first.sequence };
  });
  const retained = listRoutingNotices(state.sessionId, 0);

  expect(notices.second).toMatchObject({ kind: 'request_completed', acknowledged: false });
  expect(retained).toHaveLength(4);
  expect(retained).toContainEqual(expect.objectContaining({ kind: 'launch', sequence: notices.launchSequence }));
  expect(retained).toContainEqual(expect.objectContaining({ sequence: notices.fallbackSequence,
    previous: initial, target: replacement, acknowledged: false }));
  expect(retained).toContainEqual(expect.objectContaining({ kind: 'request_completed',
    sequence: notices.firstSequence, acknowledged: true }));
  expect(retained).toContainEqual(expect.objectContaining({ kind: 'request_completed', sequence: notices.second.sequence }));
});

it('persists the exhausted fallback and skipped target without creating a pending fallback notice', async () => {
  const state = fixture();
  state.config.categories = { implementation: { target: initial, fallbacks: [replacement] } };
  const binding = await createBinding(state);

  await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
    await expect(advanceRoutingFallback({ ...transitionInput(leased, leased.lease!, state),
      candidateAllowed: () => false })).rejects.toMatchObject({ code: 'routing_fallback_exhausted' });
    const stored = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
    const notices = listRoutingNotices(state.sessionId, 0);

    expect(stored.decision.events).toContainEqual({ reason: 'fallback_transport_unsupported', target: replacement });
    expect(stored.pendingNotice).toBeUndefined();
    expect(notices).toEqual([expect.objectContaining({ kind: 'exhausted', reason: 'quota_exhausted',
      lastAttempted: initial, attemptedCount: 1, skippedCount: 1, acknowledged: false })]);
  });
});

it('compacts old acknowledged receipts without repeating launch or selector notices', async () => {
  const state = fixture();
  const history = await createAcknowledgedNoticeHistory(state);
  const retained = listRoutingNotices(state.sessionId, 0);
  const retainedExhaustion = retained.filter(notice => 'kind' in notice && notice.kind === 'exhausted' && notice.acknowledged);
  const latestSequence = Math.max(...retained.map(notice => notice.sequence));

  await withRoutingLease({ sessionId: state.sessionId, modelId: history.binding.id }, async leased => {
    await ensureRoutingLaunchNotices({ sessionId: state.sessionId, modelId: history.binding.id,
      leaseId: leased.lease!, revision: leased.revision });
  });
  const afterRepeatedEnsure = listRoutingNotices(state.sessionId, 0);
  const afterRepeatedEnsureSequence = Math.max(...afterRepeatedEnsure.map(notice => notice.sequence));
  const nextBinding = await createRoutingBinding({ sessionId: state.sessionId, launchId: `${state.launchId}-after-history`,
    role: 'specialist', category: 'implementation', task: 'Review a new launch after compaction.', config: state.config,
    catalog: state.catalog, workload, requirements });
  const nextFallback = await withRoutingLease({ sessionId: state.sessionId, modelId: nextBinding.id }, async leased => {
    await ensureRoutingLaunchNotices({ sessionId: state.sessionId, modelId: nextBinding.id,
      leaseId: leased.lease!, revision: leased.revision });
    return advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
  });

  expect(history.exhaustionErrors).toEqual(Array.from({ length: 65 }, () => 'routing_fallback_exhausted'));
  expect(history.acknowledgedDuringLeaseCount).toBe(65);
  expect(retainedExhaustion).toHaveLength(64);
  expect(retained).not.toContainEqual(expect.objectContaining({ sequence: history.receipts[0]!.sequence }));
  expect(afterRepeatedEnsureSequence).toBe(latestSequence);
  expect(nextFallback.decision.target).toEqual(replacement);
  expect(nextFallback.pendingNotice?.acknowledged).toBe(false);
});

it('keeps acknowledged history within the byte budget for valid larger cost snapshots', async () => {
  const state = fixture();
  const primaryModel = state.catalog.models.find(model => model.ref.providerId === initial.providerId
    && model.ref.modelId === initial.modelId)!;
  primaryModel.estimate.tiers = Array.from({ length: 8 }, (_, index) => ({
    label: `Context tier ${index} ${'x'.repeat(80)}`, condition: { type: 'context' as const, size: (index + 1) * 1000 },
    input: 1, output: 1,
  }));
  const history = await createAcknowledgedNoticeHistory(state);
  const retained = listRoutingNotices(state.sessionId, 0)
    .filter(notice => 'kind' in notice && notice.kind === 'exhausted' && notice.acknowledged);
  const retainedBytes = retained.reduce((sum, notice) => sum + Buffer.byteLength(JSON.stringify(notice), 'utf8'), 0);

  expect(history.exhaustionErrors).toEqual(Array.from({ length: 65 }, () => 'routing_fallback_exhausted'));
  expect(history.acknowledgedDuringLeaseBytes).toBeGreaterThan(64 * 1024);
  expect(retainedBytes).toBeLessThanOrEqual(64 * 1024);
  expect(retained.length).toBeLessThan(64);
});

it('reconnects pending fallback notices across compaction and waits for their exact acknowledgment', async () => {
  const state = fixture();
  const proxy = await startControlService(state);
  const protectedBinding = await createBinding(state);

  try {
    await withRoutingLease({ sessionId: state.sessionId, modelId: protectedBinding.id }, async leased => {
      const pending = await advanceRoutingFallback(transitionInput(leased, leased.lease!, state));
      const protectedNotice = pending.pendingNotice!;
      const history = await createAcknowledgedNoticeHistory(state);
      const storedDuringCompaction = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: protectedBinding.id });
      const controller = new AbortController();
      let waitSettled = false;
      let waitOutcome: string | undefined;
      const waiter = awaitRoutingNotice({ sessionId: state.sessionId, sequence: protectedNotice.sequence,
        modelId: protectedBinding.id, revision: pending.revision, leaseId: leased.lease!,
        deadline: Date.parse(protectedBinding.expiresAt), signal: controller.signal }).then(
        () => { waitSettled = true; waitOutcome = 'resolved'; },
        error => { waitSettled = true; waitOutcome = (error as { code?: string }).code ?? 'rejected'; });
      const ready = await registerNoticeConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const reconnectFromZero = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token);
      const reconnectFromHighCursor = await readNoticeEvent(proxy.port, state.sessionId, consumerId, proxy.token,
        String(history.receipts.at(-1)!.sequence), true);
      const firstReceipt = history.receipts[0]!;
      const latestReceipt = history.receipts.at(-1)!;
      const compactedAck = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: firstReceipt.sequence,
        modelId: firstReceipt.modelId, revision: firstReceipt.revision,
      });
      const retainedAck = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: latestReceipt.sequence,
        modelId: latestReceipt.modelId, revision: latestReceipt.revision,
      });
      const duplicateRetainedAck = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: latestReceipt.sequence,
        modelId: latestReceipt.modelId, revision: latestReceipt.revision,
      });
      const beforeExactAck = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: protectedBinding.id });
      await expect(advanceRoutingFallback({ ...transitionInput(leased, leased.lease!, state), revision: pending.revision }))
        .rejects.toMatchObject({ code: 'routing_notice_pending' });
      const waitOutcomeBeforeExactAck = waitOutcome;
      const exactAck = await requestJson(proxy.port, 'POST', '/v1/leverframe/routing-notice-ack', proxy.token, {
        sessionId: state.sessionId, consumerId, sequence: protectedNotice.sequence,
        modelId: protectedBinding.id, revision: pending.revision,
      });
      await waiter;
      const afterExactAck = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: protectedBinding.id });
      reconnectFromHighCursor.close();
      controller.abort();

      expect(history.exhaustionErrors).toEqual(Array.from({ length: 65 }, () => 'routing_fallback_exhausted'));
      expect(storedDuringCompaction.pendingNotice?.acknowledged).toBe(false);
      expect(reconnectFromZero.notice).toMatchObject({ sequence: protectedNotice.sequence, acknowledged: false });
      expect(reconnectFromHighCursor.notice).toMatchObject({ sequence: protectedNotice.sequence, acknowledged: false });
      expect(compactedAck.status).toBe(409);
      expect(retainedAck.status).toBe(200);
      expect(duplicateRetainedAck.status).toBe(200);
      expect(beforeExactAck.pendingNotice?.acknowledged).toBe(false);
      expect(waitOutcomeBeforeExactAck).toBeUndefined();
      expect(exactAck).toMatchObject({ status: 200, body: { acknowledged: true } });
      expect(waitSettled).toBe(true);
      expect(waitOutcome).toBe('resolved');
      expect(afterExactAck.pendingNotice?.acknowledged).toBe(true);
    });
  } finally {
    await proxy.close();
  }
}, 15_000);
