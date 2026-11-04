import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { acknowledgeRoutingNotice, advanceRoutingFallback, createRoutingBinding, listRoutingNotices,
  resolveRoutingBinding, withRoutingLease } from '../src/routing-bindings.js';
import type { RoutingBinding, RoutingFallbackInput } from '../src/routing-bindings.js';
import { awaitRoutingNotice } from '../src/proxy-routing-control.js';
import { acknowledgment, assertIsolatedRoutingSession, readNoticeSequence, registerConsumer, requestJson } from './fixtures/model-routing-proxy.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const workload = { input: 120, output: 40, cacheRead: 0, cacheWrite: 0 };
const requirements = { capabilities: [], contextTokens: 1_000 };
const primary = { providerId: 'retention-primary-provider', modelId: 'retention-primary-model' };
const replacement = { providerId: 'retention-replacement-provider', modelId: 'retention-replacement-model' };
const laterReplacement = { providerId: 'retention-later-provider', modelId: 'retention-later-model' };

function retentionFixture() {
  const models = [primary, replacement, laterReplacement];
  const catalog = buildRoutingCatalog(input(models.map(ref => provider({
    id: ref.providerId,
    templateId: 'notice-retention',
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
  const config = { enabled: true, categories: { implementation: { target: primary,
    fallbacks: [replacement] } } } satisfies RoutingConfig;
  const sessionId = `notice-retention-session-${randomUUID()}`;
  assertIsolatedRoutingSession(sessionId);
  return { catalog, config, sessionId, launchId: `notice-retention-launch-${randomUUID()}` };
}

function retentionTransition(binding: RoutingBinding, leaseId: string, state: ReturnType<typeof retentionFixture>): RoutingFallbackInput {
  return { sessionId: binding.sessionId, modelId: binding.id, leaseId, revision: binding.revision,
    failure: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' },
    catalog: state.catalog, workload, requirements, maxOutputTokens: workload.output,
    deadline: Date.parse(binding.expiresAt), signal: new AbortController().signal };
}

function startRetentionControlService(state: ReturnType<typeof retentionFixture>) {
  return startHttpProxy({ host: '127.0.0.1', port: 0, routes: [],
    routing: { config: state.config, catalog: state.catalog, workload } });
}

async function createAcknowledgedFallbackHistory(state: ReturnType<typeof retentionFixture>, count = 65) {
  const records: Array<{ launchId: string; task: string; receipt: NonNullable<RoutingBinding['pendingNotice']>;
    target: RoutingBinding['decision']['target']; revision: number; whileLeased: RoutingBinding; afterRelease: RoutingBinding }> = [];

  for (let index = 0; index < count; index++) {
    const launchId = `${state.launchId}-fallback-${index}`;
    const task = `Review fallback retention case ${index}.`;
    const binding = await createRoutingBinding({ sessionId: state.sessionId, launchId, role: 'specialist',
      category: 'implementation', task, config: state.config, catalog: state.catalog, workload, requirements });
    const completed = await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const fallback = await advanceRoutingFallback(retentionTransition(leased, leased.lease!, state));
      const receipt = fallback.pendingNotice!;
      await acknowledgeRoutingNotice({ sessionId: state.sessionId, sequence: receipt.sequence,
        modelId: binding.id, revision: fallback.revision });
      const whileLeased = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      return { receipt, target: fallback.decision.target, revision: fallback.revision, whileLeased };
    });
    const afterRelease = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
    records.push({ launchId, task, ...completed, afterRelease });
  }

  return records;
}

it('bounds acknowledged fallback receipts across bindings and preserves resumed target state', async () => {
  const state = retentionFixture();
  const records = await createAcknowledgedFallbackHistory(state);
  const retained = listRoutingNotices(state.sessionId, 0)
    .filter(notice => !('kind' in notice) && notice.acknowledged);
  const retainedBytes = retained.reduce((sum, notice) => sum + Buffer.byteLength(JSON.stringify(notice), 'utf8'), 0);
  const first = records[0]!;
  const resumed = await createRoutingBinding({ sessionId: state.sessionId, launchId: first.launchId,
    role: 'specialist', category: 'implementation', task: first.task, config: state.config,
    catalog: state.catalog, workload, requirements, resume: true });

  expect(retained).toHaveLength(64);
  expect(retainedBytes).toBeLessThanOrEqual(64 * 1024);
  expect(first.whileLeased.pendingNotice).toMatchObject({ acknowledged: true, target: replacement, revision: first.revision });
  expect(first.afterRelease.pendingNotice).toBeUndefined();
  expect(first.afterRelease.decision.target).toEqual(first.target);
  expect(first.afterRelease.revision).toBe(first.revision);
  expect(resumed.decision.target).toEqual(first.target);
  expect(resumed.revision).toBe(first.revision);
  expect(retained).not.toContainEqual(expect.objectContaining({ sequence: first.receipt.sequence }));
});

it('rejects a compacted fallback ACK without releasing a newer pending transition', async () => {
  const state = retentionFixture();
  const proxy = await startRetentionControlService(state);

  try {
    const records = await createAcknowledgedFallbackHistory(state);
    const first = records[0]!;
    const retainedFallbacks = listRoutingNotices(state.sessionId, 0)
      .filter(notice => !('kind' in notice) && notice.acknowledged);
    const retainedFallbackBytes = retainedFallbacks.reduce((sum, notice) =>
      sum + Buffer.byteLength(JSON.stringify(notice), 'utf8'), 0);
    const pendingConfig = { ...state.config, categories: { implementation: { target: primary,
      fallbacks: [replacement, laterReplacement] } } } satisfies RoutingConfig;
    const binding = await createRoutingBinding({ sessionId: state.sessionId, launchId: `${state.launchId}-pending`,
      role: 'specialist', category: 'implementation', task: 'Review the pending fallback after compaction.',
      config: pendingConfig, catalog: state.catalog, workload, requirements });

    const nextFallback = await withRoutingLease({ sessionId: state.sessionId, modelId: binding.id }, async leased => {
      const fallback = await advanceRoutingFallback(retentionTransition(leased, leased.lease!, state));
      const pending = fallback.pendingNotice!;
      const controller = new AbortController();
      let waitSettled = false;
      const waiter = awaitRoutingNotice({ sessionId: state.sessionId, sequence: pending.sequence, modelId: binding.id,
        revision: fallback.revision, leaseId: leased.lease!, deadline: Date.parse(binding.expiresAt),
        signal: controller.signal }).then(() => { waitSettled = true; }, () => { waitSettled = true; });
      const ready = await registerConsumer(proxy.port, state.sessionId, proxy.token);
      const consumerId = String(ready.body.consumerId);
      const stream = readNoticeSequence(proxy.port, state.sessionId, consumerId, proxy.token, pending.sequence + 1000);
      const connection = await stream.connected;
      const event = await stream.nextNotice();
      const compactedAck = await requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token,
        acknowledgment({ sessionId: first.receipt.sessionId, sequence: first.receipt.sequence,
          modelId: first.receipt.modelId, revision: first.receipt.revision }, consumerId));
      const current = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
      await expect(advanceRoutingFallback({ ...retentionTransition(leased, leased.lease!, state), revision: fallback.revision }))
        .rejects.toMatchObject({ code: 'routing_notice_pending' });
      const waitOutcomeBeforeExactAck = waitSettled;
      const exactAck = await requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token,
        acknowledgment(event.notice, consumerId));
      await waiter;
      const next = await advanceRoutingFallback({ ...retentionTransition({ ...leased, revision: fallback.revision },
        leased.lease!, state), revision: fallback.revision });
      await acknowledgeRoutingNotice({ sessionId: state.sessionId, sequence: next.pendingNotice!.sequence,
        modelId: binding.id, revision: next.revision });
      connection.close();
      controller.abort();

      expect(event.notice).toMatchObject({ sequence: pending.sequence, acknowledged: false });
      expect(retainedFallbacks).toHaveLength(64);
      expect(retainedFallbackBytes).toBeLessThanOrEqual(64 * 1024);
      expect(compactedAck.status).toBe(409);
      expect(current.pendingNotice).toMatchObject({ sequence: pending.sequence, acknowledged: false });
      expect(waitOutcomeBeforeExactAck).toBe(false);
      expect(exactAck).toMatchObject({ status: 200, body: { acknowledged: true } });
      expect(waitSettled).toBe(true);
      expect(next.decision.target).toEqual(laterReplacement);
      return next;
    });
    const afterRelease = await resolveRoutingBinding({ sessionId: state.sessionId, modelId: binding.id });
    expect(afterRelease.decision.target).toEqual(laterReplacement);
    expect(afterRelease.revision).toBe(nextFallback.revision);
    expect(afterRelease.pendingNotice).toBeUndefined();
  } finally {
    await proxy.close();
  }
}, 30_000);

it('keeps fewer wide fallback receipts within the acknowledged byte budget', async () => {
  const state = retentionFixture();
  const fallbackModel = state.catalog.models.find(model => model.ref.providerId === replacement.providerId
    && model.ref.modelId === replacement.modelId)!;
  fallbackModel.estimate.tiers = Array.from({ length: 24 }, (_, index) => ({
    label: `Fallback price tier ${index} ${'x'.repeat(80)}`,
    condition: { type: 'context' as const, size: (index + 1) * 1000 }, input: 1, output: 1,
  }));
  const records = await createAcknowledgedFallbackHistory(state, 24);
  const retained = listRoutingNotices(state.sessionId, 0)
    .filter(notice => !('kind' in notice) && notice.acknowledged);
  const retainedBytes = retained.reduce((sum, notice) => sum + Buffer.byteLength(JSON.stringify(notice), 'utf8'), 0);

  expect(records).toHaveLength(24);
  expect(retained.length).toBeLessThan(24);
  expect(retainedBytes).toBeLessThanOrEqual(64 * 1024);
  expect(retained).not.toContainEqual(expect.objectContaining({ sequence: records[0]!.receipt.sequence }));
});
