import type { CachedModel } from '../registry/types.js';
import { callAntigravityRpc, type DiscoveryOptions } from './discovery.js';
import { ANTIGRAVITY_ORIGIN, AntigravityError, objectRecord, type AntigravityAuthSnapshot } from './types.js';

function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function catalogModel(id: string, value: unknown): CachedModel | undefined {
  const entry = objectRecord(value);
  if (!entry || !/^gemini-[a-zA-Z0-9_.-]+$/.test(id) || entry.isInternal === true
    || (entry.apiProvider !== undefined && entry.apiProvider !== 'API_PROVIDER_GOOGLE_GEMINI')) return undefined;
  const effort = /-(low|medium|high)$/.exec(id)?.[1];
  const quota = objectRecord(entry.quotaInfo);
  const fraction = quota?.remainingFraction;
  const contextWindow = positiveLimit(entry.maxTokens);
  return {
    id, upstreamModelId: id,
    name: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : id,
    family: 'gemini', brand: 'Google', modelFormat: 'cloud-code', npm: '@ai-sdk/google',
    apiUrl: ANTIGRAVITY_ORIGIN,
    contextWindow, contextWindowUnconfirmed: contextWindow === undefined ? true : undefined,
    outputTokenLimit: positiveLimit(entry.maxOutputTokens),
    supportedParameters: ['tools', 'tool_choice'],
    ...(effort ? { reasoning: true, supportedReasoningEfforts: [effort], defaultReasoningEffort: effort } : {}),
    ...(typeof entry.supportsImages === 'boolean' ? { vision: entry.supportsImages } : {}),
    subscriptionQuota: {
      remainingFraction: typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : undefined,
      resetTime: typeof quota?.resetTime === 'string' && Number.isFinite(Date.parse(quota.resetTime)) ? quota.resetTime : undefined,
    },
  };
}

export async function fetchAntigravityModels(auth: AntigravityAuthSnapshot, options: DiscoveryOptions = {}): Promise<CachedModel[]> {
  const response = await callAntigravityRpc(auth.accessToken, 'fetchAvailableModels', { project: auth.projectId }, { ...options, accountId: auth.accountId });
  const entries = objectRecord(response.models);
  if (!entries) throw new AntigravityError('Antigravity returned an invalid model catalog.');
  const models = Object.entries(entries).flatMap(([id, entry]) => {
    const model = catalogModel(id, entry);
    return model ? [model] : [];
  });
  if (!models.length) throw new AntigravityError('Antigravity returned no available Gemini models.', 403);
  return models;
}
