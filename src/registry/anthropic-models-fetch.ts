import { getProviderDebugLogPath } from '../log-paths.js';
import { makeTraceLogger } from '../trace-log.js';
import {
  ANTHROPIC_MODELS_MAX_PAGES,
  anthropicModelsPageUrl,
  anthropicRowToCachedModel,
  nextAnthropicPageCursor,
  type AnthropicModelPage,
} from './anthropic-model-list.js';
import type { CachedModel } from './types.js';
import { revalidateCustomEndpointUrl } from './url-security.js';

export interface AnthropicModelsFetchResult {
  models: CachedModel[];
  baseUrl: string;
  error?: string;
  hint?: string;
}

interface AnthropicListOutcome {
  status: number;
  models: CachedModel[];
  upstreamMessage?: string;
}

interface AnthropicListRequest {
  root: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  logTrace?: (msg: string) => void;
}

function upstreamErrorMessage(rawBodyText: string): string | undefined {
  try {
    const message = (JSON.parse(rawBodyText) as { error?: { message?: unknown } }).error?.message;
    return typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function parseAnthropicModelPage(rawBodyText: string): AnthropicModelPage {
  if (!rawBodyText.trim()) return {};
  try {
    return JSON.parse(rawBodyText) as AnthropicModelPage;
  } catch {
    return {};
  }
}

async function listAnthropicModelPages(
  { root, headers, signal, logTrace }: AnthropicListRequest,
): Promise<AnthropicListOutcome> {
  const models: CachedModel[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < ANTHROPIC_MODELS_MAX_PAGES; pageIndex += 1) {
    const url = anthropicModelsPageUrl(root, cursor);
    const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
    const rawBodyText = await response.text().catch(() => '');
    logTrace?.(`[fetchAnthropicModels] HTTP ${response.status} from ${url}`);
    logTrace?.(`[fetchAnthropicModels] Body: ${rawBodyText}`);
    if (!response.ok) return { status: response.status, models, upstreamMessage: upstreamErrorMessage(rawBodyText) };

    const page = parseAnthropicModelPage(rawBodyText);
    for (const row of page.data ?? []) {
      const model = anthropicRowToCachedModel(row, root);
      if (model) models.push(model);
    }
    cursor = nextAnthropicPageCursor(page);
    if (!cursor) break;
  }
  return { status: 200, models };
}

function listFailure(root: string, { status, upstreamMessage }: AnthropicListOutcome): AnthropicModelsFetchResult {
  if (status === 401 || status === 403) {
    return {
      models: [],
      baseUrl: root,
      error: 'API key was rejected.',
      hint: upstreamMessage ?? 'Check your Anthropic-compatible API key.',
    };
  }
  return {
    models: [],
    baseUrl: root,
    error: `Could not list models (HTTP ${status}).`,
    hint: upstreamMessage
      ?? 'Verify the base URL supports Anthropic-compatible /v1/models or try the OpenAI-compatible option instead.',
  };
}

export async function fetchAnthropicModels(
  baseUrl: string,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Promise<AnthropicModelsFetchResult> {
  const isHttp = baseUrl.trim().toLowerCase().startsWith('http://');
  const revalidation = await revalidateCustomEndpointUrl(baseUrl, { allowInsecureLocal: isHttp });
  if (!revalidation.ok) {
    return {
      models: [],
      baseUrl,
      error: revalidation.error ?? 'Custom endpoint URL failed security revalidation.',
      hint: revalidation.hint,
    };
  }
  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    Accept: 'application/json',
    ...extraHeaders,
  };
  const logTrace = process.env.LEVERFRAME_TRACE === '1'
    ? makeTraceLogger(getProviderDebugLogPath(), [apiKey])
    : undefined;

  try {
    const outcome = await listAnthropicModelPages({ root, headers, signal: controller.signal, logTrace });
    return outcome.models.length > 0 ? { models: outcome.models, baseUrl: root } : listFailure(root, outcome);
  } catch {
    return {
      models: [],
      baseUrl: root,
      error: 'Could not reach the Anthropic-compatible server.',
      hint: 'Check the base URL and that the server is running.',
    };
  } finally {
    clearTimeout(timer);
  }
}
