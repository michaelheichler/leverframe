
import {
  ONE_M_CONTEXT_WINDOW,
  hasOneMContextSuffix,
  parseContextModeModelId,
  routeLookupIds,
  stripContextMarkers,
} from './context-model-id.js';
import { revalidateCustomEndpointUrl } from './registry/url-security.js';
import type { AnthropicRequest } from './sdk-adapter.js';
import type { LifecycleDeadlines } from './request-lifecycle.js';

export async function revalidateUpstreamUrl(rawUrl: string): Promise<boolean> {
  if (!rawUrl) return true;
  const allowInsecureLocal = rawUrl.trim().toLowerCase().startsWith('http://');
  const result = await revalidateCustomEndpointUrl(rawUrl, { allowInsecureLocal });
  return result.ok;
}

export type ProxyAnthropicRequestBody = Partial<AnthropicRequest> & Record<string, unknown>;

export type ParsedAnthropicRequest =
  | { ok: true; body: ProxyAnthropicRequestBody }
  | { ok: false; status: number; message: string };

export function parseAnthropicRequest(raw: string): ParsedAnthropicRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: 'Request body must be a JSON object' };
  }
  const body = parsed as ProxyAnthropicRequestBody;
  if (body.model !== undefined && typeof body.model !== 'string') {
    return { ok: false, status: 400, message: `'model' must be a string when present, got ${typeof body.model}` };
  }
  return { ok: true, body };
}

export function proxyExecutionMessages(body: unknown): Array<{ role: string; content: unknown }> {
  if (!body || typeof body !== 'object') return [];
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const message = value as Record<string, unknown>;
    return typeof message.role === 'string' ? [{ role: message.role, content: message.content }] : [];
  });
}

export function proxyToolResults(body: unknown): Array<{ toolUseId: string; content: string }> {
  if (!body || typeof body !== 'object') return [];
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  const results: Array<{ toolUseId: string; content: string }> = [];
  for (const value of messages) {
    if (!value || typeof value !== 'object') continue;
    const content = (value as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const blockValue of content) {
      if (!blockValue || typeof blockValue !== 'object') continue;
      const block = blockValue as Record<string, unknown>;
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      results.push({
        toolUseId: block.tool_use_id,
        content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      });
    }
  }
  return results;
}

export interface ProxyRoute {
  aliasId: string;
  realModelId: string;
  displayName: string;
  upstreamUrl: string;
  apiKey: string;
  modelFormat: 'anthropic' | 'openai';
  contextWindow?: number;
  maxContextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  minimalClientVersion?: string;

  contextWindowUnconfirmed?: boolean;
  npm?: string;      // OpenCode api.npm - when SDK-migrated, routes via the adapter
  baseURL?: string;  // base URL for openai-compatible / openrouter SDK providers
  providerId?: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;

  refreshToken?: (rejectedToken: string) => Promise<string | null>;
  supportedParameters?: string[];
  reasoning?: boolean;
  supportsTemperature?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsReasoningSummaries?: boolean;
  supportsReasoningSummaryParameter?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsReasoningToggle?: boolean;
  supportsPromptCacheBreakpoints?: boolean;
  interleavedReasoningField?: string;

  useResponsesLite?: boolean;

  preferWebSockets?: boolean;

  headers?: Record<string, string>;

  requestDeadlines?: LifecycleDeadlines;
}

export function aliasModelId(realId: string, providerId: string): string {
  if (realId.startsWith('claude-')) return realId;
  const sanitized = providerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `anthropic-${sanitized}__${realId}`;
}

export function lookupRoute(byAlias: Map<string, ProxyRoute>, id: string): ProxyRoute | undefined {
  const { mode } = parseContextModeModelId(id);
  const legacyOneM = hasOneMContextSuffix(id);
  for (const key of routeLookupIds(id)) {
    const route = byAlias.get(key);
    if (!route) continue;
    if (legacyOneM) {
      const current = route.contextWindow;
      if (
        typeof current === 'number'
        && Number.isSafeInteger(current)
        && current >= ONE_M_CONTEXT_WINDOW
        && route.contextWindowUnconfirmed !== true
      ) {
        return { ...route, aliasId: id, contextWindow: current, contextWindowUnconfirmed: undefined };
      }
      const maximum = route.maxContextWindow;
      if (
        typeof current === 'number'
        && Number.isSafeInteger(current)
        && current > 0
        && typeof maximum === 'number'
        && Number.isSafeInteger(maximum)
        && maximum >= ONE_M_CONTEXT_WINDOW
        && route.contextWindowUnconfirmed !== true
      ) {
        return { ...route, aliasId: id, contextWindow: maximum, contextWindowUnconfirmed: undefined };
      }
      continue;
    }
    if (mode === 'maximum') {
      const maximum = route.maxContextWindow;
      const current = route.contextWindow;
      if (
        typeof maximum !== 'number'
        || !Number.isSafeInteger(maximum)
        || maximum <= 0
        || typeof current !== 'number'
        || !Number.isSafeInteger(current)
        || current <= 0
        || route.contextWindowUnconfirmed === true
        || maximum <= current
      ) {
        return undefined;
      }
      return { ...route, aliasId: id, contextWindow: maximum, contextWindowUnconfirmed: undefined };
    }
    if (mode === 'default') return { ...route, aliasId: id };
    return route;
  }
  return undefined;
}

export interface ProxyModelAlias {
  name: string;
  routeId: string;
}

export function proxyRuntimeRouteKey(route: ProxyRoute): string {
  const aliasId = stripContextMarkers(route.aliasId);
  return [
    route.providerId ?? aliasId,
    route.oauthAccountId ?? '',
    aliasId,
    route.realModelId,
    route.npm ?? '@native-anthropic',
    route.baseURL ?? route.upstreamUrl,
  ].join('\x1f');
}
