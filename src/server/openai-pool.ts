import type { ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { classifyPoolFailure, dispatchWithPool, poolExhaustionMessage, poolExhaustionStatus, type PoolBinding } from '../account-pool-dispatch.js';
import { getPooledCodexModel } from '../account-pool-sdk.js';
import { createLanguageModel } from '../provider-factory.js';
import { recordObservation } from '../account-pool.js';
import { anthropicCapacity } from '../account-pool-telemetry.js';
import { sdkUpstreamErrorDetails } from '../upstream-error.js';
import type { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import type { ServerModelInfo } from './models.js';
import { upstreamModelId } from './models.js';
import { sendJson } from '../http-utils.js';

type PoolKind = 'codex' | 'anthropic' | 'provider';

function poolKey(model: ServerModelInfo) {
  return { providerId: model.providerId!, modelId: upstreamModelId(model),
    billingType: model.authType === 'oauth' ? 'oauth' as const : 'api' as const };
}

async function anthropicModel(model: ServerModelInfo, binding: PoolBinding): Promise<LanguageModel> {
  const pool = poolKey(model);
  return createLanguageModel({
    npm: model.npm || '@ai-sdk/anthropic', modelId: upstreamModelId(model), apiKey: binding.apiKey,
    baseURL: model.modelFormat === 'anthropic' ? model.baseUrl : model.apiBaseUrl,
    providerId: model.providerId, authType: 'api', headers: model.headers,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (response.ok) {
        const now = Date.now();
        for (const observation of anthropicCapacity(response.headers, binding.account.id, now)) {
          await recordObservation({ pool, observation, now, generation: binding.generation });
        }
      }
      return response;
    },
  });
}

async function pooledModel(model: ServerModelInfo, binding: PoolBinding, cache: ProviderRuntimeCache<LanguageModel>, kind: PoolKind) {
  if (kind === 'anthropic') return anthropicModel(model, binding);
  return getPooledCodexModel(cache, {
    aliasId: model.id, realModelId: upstreamModelId(model), displayName: model.name,
    upstreamUrl: model.baseUrl ?? '', apiKey: binding.apiKey, modelFormat: 'openai', npm: model.npm,
    providerId: model.providerId, authType: model.authType, baseURL: model.apiBaseUrl,
    headers: model.headers, useResponsesLite: model.useResponsesLite, minimalClientVersion: model.minimalClientVersion,
  }, binding);
}

export async function dispatchOpenAiPool(options: {
  res: ServerResponse; model: ServerModelInfo; cache: ProviderRuntimeCache<LanguageModel>; kind: PoolKind;
  sessionId?: string; run: (model: LanguageModel, binding: PoolBinding) => Promise<void>;
  onExhausted: () => void;
}): Promise<void> {
  const pool = poolKey(options.model);
  const result = await dispatchWithPool({
    pool, sessionId: options.sessionId,
    accountId: options.model.accountId,
    dispatch: async binding => {
      try {
        const model = await pooledModel(options.model, binding, options.cache, options.kind);
        await options.run(model, binding);
        return { kind: 'success' as const, value: undefined };
      } catch (error) {
        const details = sdkUpstreamErrorDetails(error);
        const observation = classifyPoolFailure({ provider: options.kind, accountId: binding.account.id,
          statusCode: details?.statusCode, body: details?.data ?? details?.errorContent,
          headers: details?.responseHeaders, now: Date.now() });
        if (!observation) throw error;
        if (options.res.headersSent) {
          await recordObservation({ pool, observation, now: Date.now(), generation: binding.generation });
          throw error;
        }
        return { kind: 'failure' as const, value: error, observation };
      }
    },
  });
  if (result.kind === 'exhausted') {
    options.onExhausted();
    const status = poolExhaustionStatus(result);
    sendJson(options.res, status, { error: { message: poolExhaustionMessage(result), type: status === 400 ? 'invalid_request_error' : 'rate_limit_error' } });
  } else if (result.value !== undefined) {
    throw result.value;
  }
}

export async function dispatchOpenAiDirectPool(options: {
  res: ServerResponse; model: ServerModelInfo; kind: PoolKind; sessionId?: string;
  run: (binding: PoolBinding) => Promise<{ status: number; body: string; headers: Headers } | undefined>;
  onExhausted: () => void;
  onFailure: (status: number, body: string) => void;
}): Promise<void> {
  const pool = poolKey(options.model);
  const result = await dispatchWithPool({ pool, sessionId: options.sessionId, accountId: options.model.accountId, dispatch: async binding => {
    const rejection = await options.run(binding);
    if (!rejection) return { kind: 'success' as const, value: undefined };
    const observation = classifyPoolFailure({ provider: options.kind, accountId: binding.account.id,
      statusCode: rejection.status, body: rejection.body, headers: rejection.headers, now: Date.now() });
    return { kind: 'failure' as const, value: rejection, observation };
  } });
  if (result.kind === 'exhausted') {
    options.onExhausted();
    const status = poolExhaustionStatus(result);
    sendJson(options.res, status, { error: { message: poolExhaustionMessage(result), type: status === 400 ? 'invalid_request_error' : 'rate_limit_error' } });
  } else if (result.value) {
    options.onFailure(result.value.status, result.value.body);
    options.res.writeHead(result.value.status, { 'Content-Type': result.value.headers.get('content-type') ?? 'application/json' });
    options.res.end(result.value.body);
  }
}
