import { setTimeout as delay } from 'node:timers/promises';
import { ANTIGRAVITY_ORIGIN, AntigravityError, objectRecord } from './types.js';
import { requestGoogleJson } from './http.js';
import { assertAntigravityBillingAllowed, recordAntigravityCreditConsumption } from './billing-policy.js';

export interface DiscoveryOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  accountId?: string;
}

function observeDiscoveryBilling(options: DiscoveryOptions, payload: Record<string, unknown>): void {
  if (!options.accountId) return;
  recordAntigravityCreditConsumption(options.accountId, payload);
  recordAntigravityCreditConsumption(options.accountId, payload.response);
  assertAntigravityBillingAllowed(options.accountId);
}

export async function callAntigravityRpc(accessToken: string, method: string, payload: Record<string, unknown>, options: DiscoveryOptions = {}): Promise<Record<string, unknown>> {
  if (!/^[a-zA-Z]+$/.test(method)) throw new AntigravityError('Antigravity operation is invalid.', 400);
  if (options.accountId) assertAntigravityBillingAllowed(options.accountId);
  const result = await requestGoogleJson(`${ANTIGRAVITY_ORIGIN}/v1internal:${method}`, {
    method: 'POST', signal: options.signal,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': 'antigravity' },
    body: JSON.stringify(payload),
  }, options.fetchImpl, payload => observeDiscoveryBilling(options, payload));
  return result;
}

function managedProject(value: Record<string, unknown>): string | undefined {
  const project = value.cloudaicompanionProject;
  const id = typeof project === 'string' ? project : objectRecord(project)?.id;
  return typeof id === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(id) ? id : undefined;
}

function completedProject(operation: Record<string, unknown>): string | undefined {
  if (operation.error) throw new AntigravityError('Antigravity account provisioning failed.', 403);
  if (operation.done !== true) return undefined;
  const project = managedProject(objectRecord(operation.response) ?? {});
  if (!project) throw new AntigravityError('Antigravity account provisioning returned no managed project.');
  return project;
}

async function onboardProject(accessToken: string, tier: string, options: DiscoveryOptions): Promise<string> {
  const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
  let operation = await callAntigravityRpc(accessToken, 'onboardUser', {
    tier_id: tier, metadata: { ideType: 'ANTIGRAVITY' },
  }, { ...options, signal });
  const project = completedProject(operation);
  if (project) return project;
  const name = operation.name;
  if (typeof name !== 'string' || !/^operations\/[a-zA-Z0-9_.:-]+$/.test(name)) {
    throw new AntigravityError('Antigravity provisioning returned an invalid operation.');
  }
  for (;;) {
    await delay(1000, undefined, { signal });
    if (options.accountId) assertAntigravityBillingAllowed(options.accountId);
    operation = await requestGoogleJson(`${ANTIGRAVITY_ORIGIN}/v1internal/${name}`, {
      signal, headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'antigravity' },
    }, options.fetchImpl, payload => observeDiscoveryBilling(options, payload));
    const result = completedProject(operation);
    if (result) return result;
  }
}

export async function discoverAntigravityProject(accessToken: string, signal?: AbortSignal, fetchImpl?: typeof fetch, accountId?: string): Promise<string> {
  const options = { signal, fetchImpl, accountId };
  const body = await callAntigravityRpc(accessToken, 'loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, options);
  const project = managedProject(body);
  if (project) return project;
  const tiers = Array.isArray(body.allowedTiers) ? body.allowedTiers.map(objectRecord) : [];
  const tier = tiers.find(entry => entry?.isDefault === true)?.id;
  if (typeof tier !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tier)) {
    throw new AntigravityError('Antigravity account is not eligible or needs verification.', 403);
  }
  return onboardProject(accessToken, tier, options);
}
