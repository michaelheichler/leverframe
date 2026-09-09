

import { deriveBrand } from '../models.js';
import type { ProviderTemplate } from '../provider-templates.js';
import { normalizeGoogleDisplayName, normalizeGoogleModelId } from './google-model-id.js';
import type { CachedModel } from './types.js';
import { getProviderDebugLogPath } from '../log-paths.js';
import { makeTraceLogger } from '../trace-log.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import { revalidateCustomEndpointUrl } from './url-security.js';
import {
  fetchModelsDevCatalog,
  findModelsDevModelAnywhere,
  modelsDevReasoningEfforts,
  modelsDevSupportsReasoningToggle,
  stripModelsDevCacheMeta,
} from './models-dev.js';
import { fetchOpenCodeGoMetadata } from './supplier-metadata.js';

const TEST_TIMEOUT_MS = 10_000;

interface OpenAiModelListResponse {
  data?: ProviderModelListRow[];
  models?: ProviderModelListRow[];
}

interface ProviderModelListRow {
  id?: string;
  name?: string;
  supported_parameters?: string[];
  context_length?: number;
  contextWindow?: number;
  context_window?: number;
  isFree?: boolean;
  pricing?: Record<string, string | number | undefined>;
  use_responses_lite?: boolean;
  prefer_websockets?: boolean;
}

function modelFormatForNpm(npm: string): 'anthropic' | 'openai' {
  return npm === '@ai-sdk/anthropic' ? 'anthropic' : 'openai';
}

function modelsUrl(baseUrl: string, template: ProviderTemplate): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (template.modelsPath) {
    const path = template.modelsPath.startsWith('/') ? template.modelsPath : `/${template.modelsPath}`;
    return `${trimmed}${path}`;
  }

  if (/\/(v\d+[a-z]*|openai|beta)$/.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function perMillion(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number((value * 1_000_000).toPrecision(12));
}

function parseNativePricing(pricing: ProviderModelListRow['pricing']): CachedModel['cost'] | undefined {
  if (!pricing) return undefined;

  const inputPerToken =
    toNumber(pricing.prompt) ??
    toNumber(pricing.input) ??
    toNumber(pricing.input_cost_per_token) ??
    toNumber(pricing.inputCostPerToken);
  const outputPerToken =
    toNumber(pricing.completion) ??
    toNumber(pricing.output) ??
    toNumber(pricing.output_cost_per_token) ??
    toNumber(pricing.outputCostPerToken);

  const inputPerMillion =
    toNumber(pricing.input_per_1m_tokens) ??
    toNumber(pricing.inputPer1MTokens);
  const outputPerMillion =
    toNumber(pricing.output_per_1m_tokens) ??
    toNumber(pricing.outputPer1MTokens);

  const input = perMillion(inputPerToken) ?? inputPerMillion;
  const output = perMillion(outputPerToken) ?? outputPerMillion;
  if (input === undefined && output === undefined) return undefined;

  const cost: CachedModel['cost'] = {
    input: input ?? 0,
    output: output ?? 0,
  };

  const cacheRead = perMillion(toNumber(pricing.input_cache_read) ?? toNumber(pricing.cache_read));
  const cacheWrite = perMillion(toNumber(pricing.input_cache_write) ?? toNumber(pricing.cache_write));
  if (cacheRead !== undefined) cost.cache_read = cacheRead;
  if (cacheWrite !== undefined) cost.cache_write = cacheWrite;

  return cost;
}

function parseModelList(body: OpenAiModelListResponse, npm: string): CachedModel[] {
  const rows = body.data ?? body.models ?? [];
  const format = modelFormatForNpm(npm);
  const models: CachedModel[] = [];

  for (const row of rows) {
    const rawId = row.id?.trim();
    if (!rawId) continue;
    const { id, upstreamModelId } = normalizeGoogleModelId(rawId, npm);
    const family = id.split(/[-/:]/)[0] ?? id;
    const cost = parseNativePricing(row.pricing);
    const freeStatus = classifyFreeStatus({
      model: { cost, isFree: row.isFree },
    });

    const contextWindow =
      row.context_length ??
      row.contextWindow ??
      row.context_window;
    models.push({
      id,
      name: normalizeGoogleDisplayName(row.name, id),
      upstreamModelId,
      family,
      brand: deriveBrand(family),
      contextWindow,
      cost,
      isFree: isFreeStatus(freeStatus),
      freeStatus,
      modelFormat: format,
      npm,
      supportedParameters: Array.isArray(row.supported_parameters) ? row.supported_parameters : undefined,
      useResponsesLite: typeof row.use_responses_lite === 'boolean' ? row.use_responses_lite : undefined,
      preferWebSockets: typeof row.prefer_websockets === 'boolean' ? row.prefer_websockets : undefined,
    });
  }

  return models;
}

function markUnconfirmedContextWindows(models: CachedModel[]): CachedModel[] {
  return models.map(model => (
    typeof model.contextWindow === 'number' && model.contextWindow > 0
      ? model
      : { ...model, contextWindow: undefined, contextWindowUnconfirmed: true }
  ));
}

async function applyDynamicSupplierMetadata(
  models: CachedModel[],
  template: ProviderTemplate,
): Promise<CachedModel[] | null> {
  if (!template.modelsDevProviderId) return models;
  const catalog = await fetchModelsDevCatalog();
  if (!catalog) return null;

  const provider = stripModelsDevCacheMeta(catalog)[template.modelsDevProviderId];
  if (!provider) return null;
  const supplier = template.supplierMetadataUrl
    ? await fetchOpenCodeGoMetadata(template.supplierMetadataUrl)
    : null;

  return models.map(model => {
    const providerModel = provider.models?.[model.id];
    const capabilities = providerModel ?? findModelsDevModelAnywhere(model.id, catalog);
    const supplied = supplier?.get(model.id);
    const npm = supplied?.npm ?? providerModel?.provider?.npm ?? provider.npm ?? model.npm;

    const contextWindow = model.contextWindow ?? capabilities?.limit?.context;
    const supportedReasoningEfforts = modelsDevReasoningEfforts(capabilities);
    return {
      ...model,
      name: capabilities?.name ?? model.name,
      family: capabilities?.family ?? model.family,
      contextWindow,
      contextWindowUnconfirmed: model.contextWindowUnconfirmed === true || contextWindow === undefined,
      npm,
      modelFormat: modelFormatForNpm(npm ?? template.npm),
      cost: supplied?.cost ?? providerModel?.cost ?? model.cost,
      usageMultiplier: supplied?.usageMultiplier,
      usageMultiplierApplies: true,
      reasoning: capabilities?.reasoning ?? model.reasoning,
      supportsTemperature: capabilities?.temperature ?? model.supportsTemperature,
      inputTokenLimit: capabilities?.limit?.input ?? model.inputTokenLimit,
      outputTokenLimit: capabilities?.limit?.output ?? model.outputTokenLimit,
      supportedReasoningEfforts: supportedReasoningEfforts ?? model.supportedReasoningEfforts,
      supportsReasoningToggle: modelsDevSupportsReasoningToggle(capabilities) ?? model.supportsReasoningToggle,
      interleavedReasoningField: capabilities?.interleaved?.field ?? model.interleavedReasoningField,
      deprecated: providerModel?.status === 'deprecated' ? true : undefined,
    };
  });
}

export interface FetchTemplateModelsResult {
  models: CachedModel[];
  baseUrl: string;
  error?: string;
  hint?: string;

  usedStaticFallback?: false;
}

export async function fetchTemplateModels(
  template: ProviderTemplate,
  apiKey: string,
  baseUrlOverride?: string,
  extraHeaders?: Record<string, string>,
  urlPolicy?: { allowInsecureLocal?: boolean },
): Promise<FetchTemplateModelsResult> {
  const trimmedOverride = baseUrlOverride?.trim();
  const baseUrl = (trimmedOverride || template.defaultBaseUrl)?.replace(/\/$/, '');
  if (!baseUrl) {
    return {
      models: [],
      baseUrl: '',
      error: 'This provider needs a base URL.',
    };
  }

  if (trimmedOverride) {
    const revalidation = await revalidateCustomEndpointUrl(baseUrl, {
      allowInsecureLocal: urlPolicy?.allowInsecureLocal ?? template.apiKeyOptional === true,
    });
    if (!revalidation.ok) {
      return {
        models: [],
        baseUrl,
        error: revalidation.error ?? 'Custom endpoint URL failed security revalidation.',
        hint: revalidation.hint,
      };
    }
  }

  const url = modelsUrl(baseUrl, template);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

  const headers: Record<string, string> = { Accept: 'application/json' };
  const trimmedApiKey = apiKey.trim();
  if (template.npm === '@ai-sdk/anthropic') {
    if (trimmedApiKey) headers['x-api-key'] = trimmedApiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (trimmedApiKey) {
    headers['Authorization'] = `Bearer ${trimmedApiKey}`;
  }
  if (template.headers) Object.assign(headers, template.headers);
  if (extraHeaders) Object.assign(headers, extraHeaders);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        models: [],
        baseUrl,
        error: 'Provider redirected the connection test.',
        hint: 'Check the base URL. Redirects are blocked for security.',
      };
    }

    let logTrace: ((msg: string) => void) | undefined;
    if (process.env.LEVERFRAME_TRACE === '1') {
      logTrace = makeTraceLogger(getProviderDebugLogPath(), [trimmedApiKey]);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (logTrace) {
        logTrace(`[fetchTemplateModels] HTTP ${response.status} from ${url}`);
        logTrace(`[fetchTemplateModels] Body: ${body}`);
      }
      const detail = body.slice(0, 200).trim();
      if (response.status === 401 || response.status === 403) {
        return {
          models: [],
          baseUrl,
          error: 'API key was rejected.',
          hint: template.signupUrl
            ? `Get or verify your key at ${template.signupUrl}`
            : 'Double-check the key you pasted.',
        };
      }
      return {
        models: [],
        baseUrl,
        error: `Provider returned HTTP ${response.status}.`,
        hint: detail || 'Check your API key and try again.',
      };
    }

    const rawBodyText = await response.text().catch(() => '');
    if (logTrace) {
      logTrace(`[fetchTemplateModels] HTTP ${response.status} from ${url}`);
      logTrace(`[fetchTemplateModels] Body: ${rawBodyText}`);
    }

    let json: OpenAiModelListResponse = {};
    try {
      if (rawBodyText.trim()) {
        json = JSON.parse(rawBodyText) as OpenAiModelListResponse;
      }
    } catch {

    }

    const listedModels = parseModelList(json, template.npm);
    const supplied = await applyDynamicSupplierMetadata(listedModels, template);
    const models = supplied ? markUnconfirmedContextWindows(supplied) : null;
    if (!models) {
      return {
        models: [],
        baseUrl,
        error: 'Connected, but supplier model metadata was unavailable.',
        hint: 'Try refreshing again after models.dev is reachable.',
      };
    }
    if (models.length === 0) {
      return {
        models: [],
        baseUrl,
        error: 'Connected but no models were returned.',
        hint: 'The API key may be valid but model listing is unavailable for this provider.',
      };
    }

    return { models, baseUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = message.includes('abort') || message.includes('Abort');
    return {
      models: [],
      baseUrl,
      error: timedOut ? 'Connection timed out after 10 seconds.' : 'Could not reach the provider.',
      hint: timedOut
        ? 'Check your network or try again.'
        : 'Verify the provider is online and your API key is correct.',
    };
  } finally {
    clearTimeout(timer);
  }
}
