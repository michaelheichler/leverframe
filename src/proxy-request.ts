// src/proxy-request.ts, inbound request parsing and route resolution for the proxy
import { routeLookupIds } from './context-model-id.js';
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

/**
 * Parses and validates the raw wire body for /v1/messages (and its
 * count_tokens sibling). `model` stays optional here on purpose - Claude
 * Code's token-counting and health-probe requests omit it, and the caller
 * falls back to the default route. Beyond the type check on `model`, this
 * intentionally validates nothing else about the body's shape (e.g. a
 * non-array `messages`) - that stays the translation/relay layer's job, so
 * its existing error taxonomy (400 vs 502, retryability, etc.) for a
 * malformed-but-present field is unchanged by this refactor.
 */
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

/**
 * A single entry in a proxy catalog.
 * aliasId: the id advertised in /v1/models (must start with 'claude-' or 'anthropic-')
 * realModelId: the actual model id sent to the upstream provider
 * upstreamUrl: full chat-completions URL (openai) or base URL without /v1 (anthropic)
 * apiKey: per-route upstream key. SDK routes may intentionally be empty for
 * anonymous free providers; passthrough and Cloud Code routes still require it.
 */
export interface ProxyRoute {
  aliasId: string;
  realModelId: string;
  displayName: string;
  upstreamUrl: string;
  apiKey: string;
  modelFormat: 'anthropic' | 'openai';
  contextWindow?: number;
  /** Provider never confirmed a context window, resolve to the conservative default, never a heuristic. */
  contextWindowUnconfirmed?: boolean;
  npm?: string;      // OpenCode api.npm - when SDK-migrated, routes via the adapter
  baseURL?: string;  // base URL for openai-compatible / openrouter SDK providers
  providerId?: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;
  /** Called once on upstream HTTP 401 to get a refreshed OAuth token. Retry happens only if token differs from current apiKey. */
  refreshToken?: (rejectedToken: string) => Promise<string | null>;
  supportedParameters?: string[];
  reasoning?: boolean;
  interleavedReasoningField?: string;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
  preferWebSockets?: boolean;
  /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
  headers?: Record<string, string>;
  /** Test-only: overrides RequestLifecycle's production deadline defaults for this route's requests. */
  requestDeadlines?: LifecycleDeadlines;
}

/**
 * Produce a gateway-discovery-safe alias for a model id.
 * Claude Code's gateway discovery only shows ids starting with 'claude' or 'anthropic'.
 * claude-* ids are returned unchanged; everything else gets an 'anthropic-{providerId}__' prefix.
 * Uses stable provider id (slug), not display name - renaming a provider does not break aliases.
 */
export function aliasModelId(realId: string, providerId: string): string {
  if (realId.startsWith('claude-')) return realId;
  const sanitized = providerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `anthropic-${sanitized}__${realId}`;
}

/** Resolve catalog alias when Claude Code or legacy registry ids differ by prefix/suffix. */
export function lookupRoute(byAlias: Map<string, ProxyRoute>, id: string): ProxyRoute | undefined {
  for (const key of routeLookupIds(id)) {
    const route = byAlias.get(key);
    if (route) return route;
  }
  return undefined;
}

/** Short alias name → route id, resolvable in request bodies alongside route aliasIds. */
export interface ProxyModelAlias {
  name: string;
  routeId: string;
}

export function proxyRuntimeRouteKey(route: ProxyRoute): string {
  return [
    route.providerId ?? route.aliasId,
    route.oauthAccountId ?? '',
    route.aliasId,
    route.realModelId,
    route.npm ?? '@native-anthropic',
    route.baseURL ?? route.upstreamUrl,
  ].join('\x1f');
}
