import type { ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { classifyPoolFailure, dispatchWithPool, poolExhaustionMessage, type PoolBinding } from './account-pool-dispatch.js';
import { createLanguageModel } from './provider-factory.js';
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

interface RuntimeBinding {
  key: string;
  accountId: string;
  generation: string;
}

const runtimeBindings = new WeakMap<ProviderRuntimeCache<LanguageModel>, Map<string, RuntimeBinding>>();

function reconcileBindings(cache: ProviderRuntimeCache<LanguageModel>): void {
  const bindings = runtimeBindings.get(cache);
  if (!bindings) return;
  const provider = loadRegistry().providers.find(item => item.id === 'openai-oauth' && item.enabled && item.authType === 'oauth');
  const active = new Map((provider?.accounts ?? []).filter(account => account.enabled).map(account => [
    account.id, createHash('sha256').update(account.authRef).digest('hex'),
  ]));
  for (const [slot, binding] of bindings) {
    if (active.get(binding.accountId) === binding.generation) continue;
    cache.forget(binding.key);
    bindings.delete(slot);
  }
}

function bindingKey(cache: ProviderRuntimeCache<LanguageModel>, route: ProxyRoute, binding: PoolBinding): string {
  reconcileBindings(cache);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    binding.generation, binding.apiKey, binding.oauthAccountId, binding.providerData,
  ])).digest('hex');
  const slot = ['openai-oauth', binding.account.id, route.realModelId, route.baseURL ?? ''].join('\x1f');
  const key = `${slot}\x1f${fingerprint}`;
  let bindings = runtimeBindings.get(cache);
  if (!bindings) {
    bindings = new Map();
    runtimeBindings.set(cache, bindings);
  }
  const previous = bindings.get(slot);
  if (previous && previous.key !== key) cache.forget(previous.key);
  bindings.set(slot, { key, accountId: binding.account.id, generation: binding.generation });
  return key;
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
    heartbeat.arm();
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
  sessionId?: string;
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
  reconcileBindings(options.cache);
  const result = await dispatchWithPool({
    pool: { providerId: 'openai-oauth', modelId: route.realModelId, billingType: 'oauth' },
    sessionId: options.sessionId,
    dispatch: async binding => {
      const key = bindingKey(options.cache, route, binding);
      const credential = options.cache.snapshot(key, binding.apiKey);
      const model = await options.cache.getHandle(key, credential, snapshot => createLanguageModel({
        npm: route.npm!, modelId: route.realModelId, apiKey: snapshot.credential,
        baseURL: route.baseURL, providerId: route.providerId, authType: route.authType,
        oauthAccountId: binding.oauthAccountId, providerData: binding.providerData,
        headers: route.headers, useResponsesLite: route.useResponsesLite, preferWebSockets: false,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
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
      }));
      const params = { ...options.params, maxRetries: 0 };
      try {
        options.onDispatch?.();
        if (options.stream) {
          await streamPoolResponse(options, model, params);
        } else {
          const response = await generateAnthropicResponse(model, params, options.clientModelId, {
            forceStream: true, abortSignal: options.signal, lifecycle: options.lifecycle,
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
          provider: 'codex', accountId: binding.account.id, statusCode: details?.statusCode,
          body: details?.data ?? details?.errorContent, headers: details?.responseHeaders, now: Date.now(),
        });
        if (!observation) throw error;
        if (res.headersSent) {
          try {
            await recordObservation({
              pool: { providerId: 'openai-oauth', modelId: route.realModelId, billingType: 'oauth' },
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
    options.lifecycle.fail(new Error('Account pool exhausted'));
    options.tracking.fail(undefined);
    options.onExhausted?.();
    applyProxyExecutionHeaders(res, options.tracking);
    anthropicError(res, 429, poolExhaustionMessage(result));
  } else if (result.value !== undefined) {
    throw result.value;
  }
}
