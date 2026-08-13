import type * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProxyRoute } from '../proxy.js';
import { anthropicMessagesEndpoint, type AnthropicMessagesEndpoint } from '../anthropic-endpoints.js';
import { anthropicEffortFromRequest, extractClaudeSessionId, type AnthropicRequest } from '../sdk-adapter.js';
import { INFERENCE_PROGRESS_INTERVAL_MS } from '../log-paths.js';
import {
  getLatestMessagePreview,
  writeInferenceRequestLog,
  writeWebSocketDiagnosticRequestLog,
} from '../trace-log.js';

/** Lifecycle-log wiring shared by both dispatch actions. */
export interface HttpProxyRouteLifecycle {
  logPath: string;
  requestId: string;
  modelId: string;
  provider: string;
  progressIntervalMs: number;
}

/**
 * Exhaustive dispatch decision for one `mitmServer` request. The HTTP handler
 * switches on `action` and never re-derives routing or logging on its own —
 * every branch it can take is represented here.
 */
export type HttpProxyRouteDecision =
  | {
      action: 'translated';
      route: ProxyRoute;
      lifecycle?: HttpProxyRouteLifecycle;
    }
  | {
      action: 'passthrough-messages';
      requestId: string;
      modelId: string;
      lifecycle?: HttpProxyRouteLifecycle;
    }
  | {
      /** Non-`/v1/messages` Anthropic traffic (e.g. `count_tokens`, non-POST): raw passthrough, no logging. */
      action: 'raw';
    };

export interface HttpProxyRouteInput {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  /** Positive allowlist of relay routes, keyed by every id the client may send. */
  routesById: Map<string, ProxyRoute>;
  /** Whether a relay adapter is running; a route with no adapter still fails closed to passthrough. */
  hasAdapter: boolean;
  inferenceLogPath?: string;
  webSocketDiagnosticsLogPath?: string;
  responseProgressIntervalMs?: number;
}

interface ParsedMessagesRequest {
  parsed: AnthropicRequest | null;
  route: ProxyRoute | undefined;
  modelId: string;
  claudeSessionId: string | undefined;
}

function providerLabel(route: ProxyRoute): string {
  return route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown';
}

/** Parse the body and resolve its route. Fails safe: a parse issue leaves `route` unset. */
function parseMessagesRequest(input: HttpProxyRouteInput): ParsedMessagesRequest {
  let parsed: AnthropicRequest | null = null;
  let route: ProxyRoute | undefined;
  try {
    parsed = JSON.parse(input.rawBody.toString('utf8')) as AnthropicRequest;
    if (typeof parsed.model === 'string') route = input.routesById.get(parsed.model);
  } catch {
    // Fail safe: an unreadable body is Anthropic traffic, never a relay route.
  }
  const modelId = typeof parsed?.model === 'string' ? parsed.model : 'unknown';
  const headerValue = input.headers['x-claude-code-session-id'];
  const claudeSessionIdHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const claudeSessionId = parsed ? extractClaudeSessionId(parsed, claudeSessionIdHeader) : undefined;
  return { parsed, route, modelId, claudeSessionId };
}

/** Everything downstream logging/lifecycle wiring needs about one decided request. */
interface DecisionContext {
  input: HttpProxyRouteInput;
  messagesEndpoint: AnthropicMessagesEndpoint;
  request: ParsedMessagesRequest;
  requestId: string;
  provider: string;
  routeKind: 'translated' | 'passthrough';
}

/** Append the request-side inference/diagnostic log entries, if the caller opted in. */
function writeRequestLogs(ctx: DecisionContext): void {
  if (ctx.messagesEndpoint !== 'messages') return;
  const { input, request, requestId, provider, routeKind } = ctx;
  const { parsed, modelId, claudeSessionId } = request;

  if (input.inferenceLogPath) {
    writeInferenceRequestLog(input.inferenceLogPath, {
      requestId,
      claudeSessionId,
      modelId,
      effort: parsed ? anthropicEffortFromRequest(parsed) : undefined,
      provider,
      route: routeKind,
      stream: Boolean(parsed?.stream),
      requestPreview: getLatestMessagePreview(parsed?.messages, parsed?.system),
    });
  }

  if (input.webSocketDiagnosticsLogPath) {
    writeWebSocketDiagnosticRequestLog(input.webSocketDiagnosticsLogPath, {
      requestId,
      claudeSessionId,
      provider,
      route: routeKind,
      headers: input.headers,
      body: parsed ? parsed as unknown as Record<string, unknown> : {},
    });
  }
}

function buildLifecycle(ctx: DecisionContext): HttpProxyRouteLifecycle | undefined {
  if (ctx.messagesEndpoint !== 'messages' || !ctx.input.inferenceLogPath) return undefined;
  return {
    logPath: ctx.input.inferenceLogPath,
    requestId: ctx.requestId,
    modelId: ctx.request.modelId,
    provider: ctx.provider,
    progressIntervalMs: ctx.input.responseProgressIntervalMs ?? INFERENCE_PROGRESS_INTERVAL_MS,
  };
}

/**
 * Application service: decides adapter-vs-native-Anthropic routing for one
 * request and performs the request-side inference/diagnostic log writes that
 * decision depends on. The HTTP handler stays limited to auth, body parsing,
 * transport dispatch on the returned `action`, and response writing.
 *
 * Fail-closed by construction: a parse failure or unresolved route id leaves
 * `route` unset, so the request always falls back to raw Anthropic
 * passthrough — never to the adapter.
 */
export function decideHttpProxyRoute(input: HttpProxyRouteInput): HttpProxyRouteDecision {
  const messagesEndpoint = anthropicMessagesEndpoint(input.url);
  if (input.method !== 'POST' || !messagesEndpoint) {
    return { action: 'raw' };
  }

  const requestId = randomUUID();
  const request = parseMessagesRequest(input);
  const { route, modelId } = request;
  const provider = route ? providerLabel(route) : 'anthropic';
  const dispatchToAdapter = Boolean(route && input.hasAdapter);
  const ctx: DecisionContext = {
    input,
    messagesEndpoint,
    request,
    requestId,
    provider,
    routeKind: dispatchToAdapter ? 'translated' : 'passthrough',
  };
  writeRequestLogs(ctx);
  const lifecycle = buildLifecycle(ctx);

  if (route && dispatchToAdapter) {
    return { action: 'translated', route, lifecycle };
  }
  return { action: 'passthrough-messages', requestId, modelId, lifecycle };
}
