import { loadPreferences } from './config.js';
import { resolveProviderAccountAuth } from './env.js';
import { loadRegistry } from './registry/io.js';
import { recordObservation, releaseReservation, reserveAccount } from './account-pool.js';
import type { CapacityObservation, PoolKey } from './account-pool.js';
import type { RegistryAccount } from './registry/types.js';
import { createHash } from 'node:crypto';
import { codexCapacity } from './account-pool-telemetry.js';
import { recordPoolActivity } from './account-pool-activity.js';

export interface PoolFailure {
  provider: 'anthropic' | 'codex';
  accountId: string;
  statusCode?: number;
  body?: unknown;
  headers?: Headers | Record<string, string | undefined>;
  now: number;
}

function header(headers: PoolFailure['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function classifyPoolFailure(input: PoolFailure): CapacityObservation | undefined {
  if (input.statusCode !== 429) return undefined;
  let payload = input.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return undefined; }
  }
  const error = record(record(payload)?.error);
  const type = error?.type ?? error?.code;
  const confirmed = input.provider === 'anthropic'
    ? type === 'rate_limit_error'
    : type === 'usage_limit_reached' || type === 'insufficient_quota';
  if (!confirmed) return undefined;
  const retry = header(input.headers, 'retry-after');
  const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : undefined;
  const retryTime = seconds === undefined ? NaN : input.now + seconds * 1000;
  const retryAt = Number.isFinite(retryTime) && retryTime <= 8.64e15 ? retryTime : undefined;
  const blocked = input.provider === 'anthropic' ? ['requests', 'input-tokens', 'output-tokens']
    .filter(unit => header(input.headers, `anthropic-ratelimit-${unit}-remaining`) === '0') : [];
  const resets = blocked.map(unit => Date.parse(header(input.headers, `anthropic-ratelimit-${unit}-reset`) ?? ''));
  const headers = input.headers instanceof Headers ? input.headers : new Headers(
    Object.entries(input.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const codexBlocked = input.provider === 'codex'
    ? codexCapacity(headers, input.accountId, input.now).filter(item => item.status === 'rate_limited') : [];
  const codexReset = codexBlocked.length && codexBlocked.every(item => item.resetAt !== undefined)
    ? Math.max(...codexBlocked.map(item => item.resetAt!)) : undefined;
  const headerReset = resets.length && resets.every(Number.isFinite) ? Math.max(...resets) : codexReset;
  const resetAt = retryAt !== undefined && headerReset !== undefined ? Math.max(retryAt, headerReset) : retryAt ?? headerReset;
  return {
    accountId: input.accountId, scope: { kind: 'pool' }, source: `${input.provider}:rejection`,
    observedAt: input.now, status: 'rate_limited', ...(resetAt === undefined ? {} : { resetAt }),
  };
}

export interface PoolBinding {
  account: RegistryAccount;
  apiKey: string;
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;
  generation: string;
}

function accountGeneration(account: RegistryAccount): string {
  return createHash('sha256').update(account.authRef).digest('hex');
}

export function isConfiguredPool(providerId: string, billingType: 'api' | 'oauth'): boolean {
  if ((providerId !== 'anthropic-api' || billingType !== 'api')
    && (providerId !== 'openai-oauth' || billingType !== 'oauth')) return false;
  const provider = loadRegistry().providers.find(item => item.id === providerId);
  return provider?.authType === billingType && Array.isArray(provider.accounts);
}

export function rememberConfiguredPool(managed: Set<string>, providerId: string, billingType: 'api' | 'oauth'): boolean {
  const key = `${providerId}:${billingType}`;
  if (isConfiguredPool(providerId, billingType)) managed.add(key);
  return managed.has(key);
}

export type PoolAttempt<T> = { kind: 'success'; value: T } | { kind: 'failure'; value: T; observation?: CapacityObservation };
export type PoolDispatchResult<T> = { kind: 'result'; value: T } | {
  kind: 'exhausted'; attempted: string[]; accounts: Array<{ accountId: string; status: string; resetAt?: number }>;
};

export function poolExhaustionMessage(result: Extract<PoolDispatchResult<unknown>, { kind: 'exhausted' }>): string {
  const resets = result.accounts.flatMap(account => account.resetAt === undefined
    ? [] : [`${account.accountId}: ${new Date(account.resetAt).toISOString()}`]);
  return `Account pool exhausted. Attempted: ${result.attempted.join(', ') || 'none'}.${resets.length ? ` Confirmed resets: ${resets.join(', ')}.` : ''}`;
}

export async function dispatchWithPool<T>(options: {
  pool: PoolKey;
  sessionId?: string;
  dispatch: (binding: PoolBinding) => Promise<PoolAttempt<T>>;
}): Promise<PoolDispatchResult<T>> {
  const attempted: string[] = [];
  const excluded: string[] = [];
  const failures: Array<{ accountId: string; status: string; resetAt?: number }> = [];
  let lastFailure: T | undefined;
  while (true) {
    const provider = loadRegistry().providers.find(item => item.id === options.pool.providerId && item.enabled);
    const accounts = provider?.accounts ?? [];
    const preferences = loadPreferences();
    const selection = await reserveAccount({
      pool: options.pool, sessionId: options.sessionId,
      accounts: accounts.map(account => ({ ...account, generation: accountGeneration(account) })),
      balancing: preferences.accountPoolBalancing !== false, pinnedAccountId: provider?.pinnedAccountId,
      now: Date.now(), excludeAccountIds: excluded,
    });
    if (selection.kind === 'exhausted') {
      const pinned = selection.accounts.find(item => item.accountId === provider?.pinnedAccountId);
      if (preferences.accountPoolFailover !== false && pinned
        && (pinned.status === 'rate_limited' || pinned.status === 'exhausted')
        && !excluded.includes(pinned.accountId)) {
        excluded.push(pinned.accountId);
        continue;
      }
      if (lastFailure !== undefined && preferences.accountPoolFailover === false) return { kind: 'result', value: lastFailure };
      return { kind: 'exhausted', attempted, accounts: [...failures, ...selection.accounts] };
    }
    const latest = loadRegistry().providers.find(item => item.id === options.pool.providerId && item.enabled);
    const account = latest?.authType === options.pool.billingType
      ? latest.accounts?.find(item => item.id === selection.reservation.accountId && item.enabled)
      : undefined;
    try {
      if (!account) {
        attempted.push(selection.reservation.accountId);
        excluded.push(selection.reservation.accountId);
        continue;
      }
      const selected = accounts.find(item => item.id === account.id);
      if (!selected || accountGeneration(selected) !== accountGeneration(account)) continue;
      const auth = await resolveProviderAccountAuth(options.pool.providerId, account);
      if (!auth.apiKey) throw new Error(`Credential unavailable for account ${account.id}`);
      attempted.push(account.id);
      excluded.push(account.id);
      const generation = accountGeneration(account);
      await recordPoolActivity(options.pool, account.id, excluded.length > 1);
      const result = await options.dispatch({ account, apiKey: auth.apiKey, oauthAccountId: auth.accountId, providerData: auth.providerData, generation });
      if (result.kind === 'success' || !result.observation) return { kind: 'result', value: result.value };
      await recordObservation({ pool: options.pool, observation: result.observation, now: Date.now(), generation });
      failures.push({ accountId: account.id, status: result.observation.status,
        ...(result.observation.resetAt === undefined ? {} : { resetAt: result.observation.resetAt }) });
      lastFailure = result.value;
      if (preferences.accountPoolFailover === false) return { kind: 'result', value: result.value };
    } finally {
      await releaseReservation({ pool: options.pool, reservationId: selection.reservation.id, now: Date.now() });
    }
  }
}
