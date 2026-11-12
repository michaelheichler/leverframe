import type { ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { classifyPoolFailure, dispatchWithPool, poolExhaustionMessage, poolExhaustionStatus, type PoolBinding } from './account-pool-dispatch.js';
import { createLanguageModel, isOpenAiOAuth } from './provider-factory.js';
import type { ProviderRuntimeCache } from './provider-runtime-cache.js';
import type { ProxyRoute } from './proxy-request.js';
import type { SdkCallParams } from './sdk-request-translation.js';
import { generateAnthropicResponse, streamAnthropicResponse } from './sdk-adapter.js';
import type { AnthropicUsageTrace } from './sdk-adapter.js';
import { sdkUpstreamErrorDetails } from './upstream-error.js';
import { anthropicError, applyProxyExecutionHeaders } from './proxy-response.js';
import { sendJson } from './http-utils.js';
import type { ExecutionTrackingHandle } from './execution-tracking.js';
import type { RequestExecutionContext } from './request-execution-context.js';
import { createSseHeartbeat } from './sse-heartbeat.js';
import { recordObservation } from './account-pool.js';
import { codexCapacity, codexEventCapacity, observeCodexEvents } from './account-pool-telemetry.js';
import { createHash } from 'node:crypto';
import { loadRegistry } from './registry/io.js';
import { routingGuardedFetch } from './routing-before-send.js';
import { routingSdkPoolUnavailable, routingSdkPrecommit, RoutingSdkRejected } from './routing-sdk-outcome.js';
import { getTemplateById } from './provider-templates.js';

interface RuntimeBinding {
  key: string;
  providerId: string;
  accountId: string;
  generation: string;
}

const runtimeBindings = new WeakMap<ProviderRuntimeCache<LanguageModel>, Map<string, RuntimeBinding>>();

function reconcileBindings(cache: ProviderRuntimeCache<LanguageModel>): void {
  const bindings = runtimeBindings.get(cache);
  if (!bindings) return;
  const active = new Map(loadRegistry().providers.filter(provider => provider.enabled).flatMap(provider =>
    (provider.accounts ?? []).filter(account => account.enabled).map(account => [
      `${provider.id}:${account.id}`, createHash('sha256').update(account.authRef).digest('hex'),
    ])));
  for (const [slot, binding] of bindings) {
    if (active.get(`${binding.providerId}:${binding.accountId}`) === binding.generation) continue;
    cache.forget(binding.key);
    bindings.delete(slot);
  }
}

function bindingKey(cache: ProviderRuntimeCache<LanguageModel>, route: ProxyRoute, binding: PoolBinding): string {
  reconcileBindings(cache);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    binding.generation, binding.apiKey, binding.oauthAccountId, binding.providerData,
  ])).digest('hex');
  const slot = [route.providerId, binding.account.id, route.npm, route.realModelId, route.baseURL ?? ''].join('\x1f');
  const key = `${slot}\x1f${fingerprint}`;
  let bindings = runtimeBindings.get(cache);
  if (!bindings) {
    bindings = new Map();
    runtimeBindings.set(cache, bindings);
  }
  const previous = bindings.get(slot);
  if (previous && previous.key !== key) cache.forget(previous.key);
  bindings.set(slot, { key, providerId: route.providerId!, accountId: binding.account.id, generation: binding.generation });
  return key;
}

export async function getPooledCodexModel(cache: ProviderRuntimeCache<LanguageModel>, route: ProxyRoute, binding: PoolBinding, selectorAttemptFetch?: typeof fetch): Promise<LanguageModel> {
  const key = bindingKey(cache, route, binding);
  const credential = cache.snapshot(key, binding.apiKey);
  const create = (apiKey: string) => createLanguageModel({
    npm: route.npm!, modelId: route.realModelId, apiKey: route.authType === 'none' ? '' : apiKey,
    baseURL: route.baseURL, providerId: route.providerId, authType: route.authType,
    oauthAccountId: binding.oauthAccountId, providerData: { ...binding.providerData, leverframeAccountId: binding.account.id },
    headers: route.headers, useResponsesLite: route.useResponsesLite, preferWebSockets: false,
    fetch: async (input, init) => {
      const response = await routingGuardedFetch(selectorAttemptFetch ?? fetch)(input, init);
      if (route.providerId !== 'openai-oauth') return response;
      if (response.ok) {
        const now = Date.now();
        for (const observation of codexCapacity(response.headers, binding.account.id, now)) {
          await recordObservation({ pool: { providerId: 'openai-oauth', modelId: route.realModelId, billingType: 'oauth' },
            observation, now, generation: binding.generation });
        }
      }
      return observeCodexEvents(response, async payload => {
        const now = Date.now();
        for (const observation of codexEventCapacity(payload, binding.account.id, now)) {
          await recordObservation({ pool: { providerId: 'openai-oauth', modelId: route.realModelId, billingType: 'oauth' },
            observation, now, generation: binding.generation });
        }
      });
    },
  });
  return selectorAttemptFetch ? create(binding.apiKey) : cache.getHandle(key, credential, snapshot => create(snapshot.credential));
}

async function streamPoolResponse(
  options: Parameters<typeof dispatchSdkPool>[0], model: LanguageModel, params: SdkCallParams,
): Promise<void> {
  const { res } = options;
  const startResponse = () => {
    if (res.headersSent) return;
    applyProxyExecutionHeaders(res, options.tracking);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  };
  const heartbeat = createSseHeartbeat(() => {
    startResponse();
    options.lifecycle.markOutputEmitted();
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
  }, () => !res.writableEnded && !res.destroyed);
  try {
    if (!options.deferRoutingFailure) heartbeat.arm();
    await streamAnthropicResponse(model, params, options.clientModelId, chunk => {
      startResponse();
      options.lifecycle.markOutputEmitted();
      options.tracking.observeAnthropicSseText(chunk);
      options.onOutput?.(chunk);
      res.write(chunk);
      heartbeat.reset();
    }, undefined, { abortSignal: options.signal, clientAbortSignal: options.signal, lifecycle: options.lifecycle,
      contextWindow: options.contextWindow, initialInputTokens: options.initialInputTokens,
      onPart: options.onPart, onUsage: options.onUsage });
  } finally {
    heartbeat.clear();
  }
  options.lifecycle.complete();
  res.end();
}

export async function dispatchSdkPool(options: {
  res: ServerResponse;
  route: ProxyRoute;
  params: SdkCallParams;
  cache: ProviderRuntimeCache<LanguageModel>;
  selectorAttemptFetch?: typeof fetch;
  deferRoutingFailure?: boolean;
  sessionId?: string;
  eligibleAccount?: Parameters<typeof dispatchWithPool>[0]['eligibleAccount'];
  clientModelId: string;
  stream: boolean;
  signal: AbortSignal;
  lifecycle: RequestExecutionContext;
  tracking: ExecutionTrackingHandle;
  contextWindow?: number;
  initialInputTokens?: number;
  onDispatch?: () => void;
  onPart?: (partType: string) => void;
  onUsage?: (usage: AnthropicUsageTrace) => void;
  onOutput?: (chunk: string) => void;
  onComplete?: () => void;
  onExhausted?: () => void;
}): Promise<void> {
  const { route, res } = options;
  let lastClassifiedError: unknown;
  reconcileBindings(options.cache);
  const result = await dispatchWithPool({
    pool: { providerId: route.providerId!, modelId: route.realModelId, billingType: route.authType === 'oauth' ? 'oauth' : 'api' },
    sessionId: options.sessionId,
    accountId: route.accountId,
    eligibleAccount: options.eligibleAccount,
    maxDispatches: options.selectorAttemptFetch ? 1 : getTemplateById(route.providerId ?? '')?.maxDispatches,
    skipMissingCredentials: options.deferRoutingFailure === true,
    dispatch: async binding => {
      const model = await getPooledCodexModel(options.cache, route, binding, options.selectorAttemptFetch);
      const params = { ...options.params, maxRetries: 0 };
      try {
        options.onDispatch?.();
        if (options.stream) {
          await streamPoolResponse(options, model, params);
        } else {
          const response = await generateAnthropicResponse(model, params, options.clientModelId, {
            forceStream: isOpenAiOAuth(route.npm, route.authType, route.providerId), abortSignal: options.signal, lifecycle: options.lifecycle,
            contextWindow: options.contextWindow, onPart: options.onPart, onUsage: options.onUsage,
          });
          options.onOutput?.(JSON.stringify(response));
          options.tracking.observeNonStreamAnthropic(response);
          options.lifecycle.markOutputEmitted();
          options.lifecycle.complete();
          applyProxyExecutionHeaders(res, options.tracking);
          sendJson(res, 200, response);
        }
        options.onComplete?.();
        return { kind: 'success' as const, value: undefined };
      } catch (error) {
        const details = sdkUpstreamErrorDetails(error);
        const observation = classifyPoolFailure({
          provider: route.providerId === 'openai-oauth' ? 'codex' : route.providerId!, accountId: binding.account.id, statusCode: details?.statusCode,
          body: details?.data ?? details?.errorContent, headers: details?.responseHeaders, now: Date.now(),
        });
        if (!observation) throw error;
        if (!res.headersSent) lastClassifiedError = error;
        if (res.headersSent) {
          try {
            await recordObservation({
              pool: { providerId: route.providerId!, modelId: route.realModelId, billingType: route.authType === 'oauth' ? 'oauth' : 'api' },
              observation, now: Date.now(), generation: binding.generation,
            });
          } catch {
            console.error('Failed to record account pool observation');
          }
          throw error;
        }
        return { kind: 'failure' as const, value: error, observation };
      }
    },
  });
  if (result.kind === 'exhausted') {
    if (options.deferRoutingFailure && lastClassifiedError !== undefined) throw lastClassifiedError;
    if (options.deferRoutingFailure && result.attempted.length === 0 && result.accounts.length === 0
      && result.missingCredentialAccounts?.length && routingSdkPrecommit(res, options.lifecycle.getSnapshot(), options.lifecycle.abortSignal)) {
      throw new RoutingSdkRejected({ reason: 'credential_missing', acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' });
    }
    if (options.deferRoutingFailure && result.attempted.length === 0 && !result.missingCredentialAccounts?.length) {
      const failure = routingSdkPoolUnavailable(result.accounts, res, options.lifecycle.getSnapshot(), options.lifecycle.abortSignal);
      if (failure) throw new RoutingSdkRejected(failure);
    }
    options.lifecycle.fail(new Error('Account pool exhausted'));
    options.tracking.fail(undefined);
    options.onExhausted?.();
    applyProxyExecutionHeaders(res, options.tracking);
    anthropicError(res, poolExhaustionStatus(result), poolExhaustionMessage(result));
  } else if (result.value !== undefined) {
    throw result.value;
  }
}
