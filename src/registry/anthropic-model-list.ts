import { deriveBrand } from '../models.js';
import type { CachedModel } from './types.js';

export interface AnthropicModelRow {
  id?: string;
  display_name?: string;
  name?: string;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
  lifecycle?: string;
}

export interface AnthropicModelPage {
  data?: AnthropicModelRow[];
  has_more?: boolean;
  last_id?: string | null;
}

export const ANTHROPIC_MODELS_PAGE_LIMIT = 1000;
export const ANTHROPIC_MODELS_MAX_PAGES = 10;

function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// Because compatible servers often omit lifecycle, missing means active.
function isActiveRow(row: AnthropicModelRow): boolean {
  return row.lifecycle === undefined || row.lifecycle === 'active';
}

export function anthropicModelsPageUrl(root: string, afterId?: string): string {
  const url = new URL(`${root}/v1/models`);
  url.searchParams.set('limit', String(ANTHROPIC_MODELS_PAGE_LIMIT));
  if (afterId) url.searchParams.set('after_id', afterId);
  return url.toString();
}

export function anthropicRowToCachedModel(row: AnthropicModelRow, apiUrl: string): CachedModel | undefined {
  const id = row.id?.trim();
  if (!id || !isActiveRow(row)) return undefined;
  const contextWindow = positiveTokenCount(row.max_input_tokens);
  const outputTokenLimit = positiveTokenCount(row.max_tokens);
  return {
    id,
    name: row.display_name?.trim() || row.name?.trim() || id,
    upstreamModelId: id,
    family: id.split('-')[0] ?? id,
    brand: deriveBrand(id),
    contextWindow,
    contextWindowUnconfirmed: contextWindow === undefined ? true : undefined,
    inputTokenLimit: contextWindow,
    outputTokenLimit,
    modelFormat: 'anthropic',
    npm: '@ai-sdk/anthropic',
    apiUrl,
  };
}

export function nextAnthropicPageCursor(page: AnthropicModelPage): string | undefined {
  if (page.has_more !== true) return undefined;
  const cursor = page.last_id?.trim();
  return cursor ? cursor : undefined;
}
