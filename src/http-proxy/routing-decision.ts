import type * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProxyRoute } from '../proxy.js';
import { anthropicMessagesEndpoint, type AnthropicMessagesEndpoint } from '../anthropic-endpoints.js';
import { anthropicEffortFromRequest, extractClaudeSessionId, type AnthropicRequest } from '../sdk-adapter.js';
import { HTTP_PROXY_MODEL_PREFIX } from './routes.js';
import { routeLookupIds } from '../context-model-id.js';
import { INFERENCE_PROGRESS_INTERVAL_MS } from '../log-paths.js';
import { lookupRoute } from '../proxy-request.js';
import {
  getLatestMessagePreview,
  writeInferenceRequestLog,
  writeWebSocketDiagnosticRequestLog,
} from '../trace-log.js';

export interface HttpProxyRouteLifecycle {
  logPath: string;
  requestId: string;
  modelId: string;
  provider: string;
  progressIntervalMs: number;
}

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
      action: 'rejected';
      requestId: string;
      modelId: string;
      message: string;
      lifecycle?: HttpProxyRouteLifecycle;
    }
  | {

      action: 'raw';
    };

export interface HttpProxyRouteInput {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;

  routesById: Map<string, ProxyRoute>;

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

function routeIdentityForModel(
  routesById: Map<string, ProxyRoute>,
  modelId: string,
): ProxyRoute | undefined {
  for (const candidate of routeLookupIds(modelId)) {
    const route = routesById.get(candidate);
    if (route) return route;
  }
  return undefined;
}

function parseMessagesRequest(input: HttpProxyRouteInput): ParsedMessagesRequest {
  let parsed: AnthropicRequest | null = null;
  let route: ProxyRoute | undefined;
  try {
    parsed = JSON.parse(input.rawBody.toString('utf8')) as AnthropicRequest;
    if (typeof parsed.model === 'string') route = lookupRoute(input.routesById, parsed.model);
  } catch {

  }
  const modelId = typeof parsed?.model === 'string' ? parsed.model : 'unknown';
  const headerValue = input.headers['x-claude-code-session-id'];
  const claudeSessionIdHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const claudeSessionId = parsed ? extractClaudeSessionId(parsed, claudeSessionIdHeader) : undefined;
  return { parsed, route, modelId, claudeSessionId };
}

interface DecisionContext {
  input: HttpProxyRouteInput;
  messagesEndpoint: AnthropicMessagesEndpoint;
  request: ParsedMessagesRequest;
  requestId: string;
  provider: string;
  routeKind: 'translated' | 'passthrough';
}

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

export function decideHttpProxyRoute(input: HttpProxyRouteInput): HttpProxyRouteDecision {
  const messagesEndpoint = anthropicMessagesEndpoint(input.url);
  if (input.method !== 'POST' || !messagesEndpoint) {
    return { action: 'raw' };
  }

  const requestId = randomUUID();
  const request = parseMessagesRequest(input);
  const { route, modelId } = request;
  const requestedModelId = typeof request.parsed?.model === 'string' ? request.parsed.model : undefined;
  const routeIdentity = route ?? (requestedModelId === undefined
    ? undefined
    : routeIdentityForModel(input.routesById, requestedModelId));
  const isNativeAnthropicModel = routeIdentity?.providerId === 'anthropic'
    && routeIdentity.modelFormat === 'anthropic';
  const isExternalModel = !isNativeAnthropicModel && (
    modelId.toLowerCase().startsWith(HTTP_PROXY_MODEL_PREFIX)
    || routeIdentity !== undefined
  );
  const provider = route ? providerLabel(route) : isExternalModel ? 'leverframe' : 'anthropic';
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

  if (!route && isExternalModel) {
    return {
      action: 'rejected',
      requestId,
      modelId,
      message: `Unknown model: ${modelId}`,
      lifecycle,
    };
  }
  if (route && dispatchToAdapter) {
    return { action: 'translated', route, lifecycle };
  }
  return { action: 'passthrough-messages', requestId, modelId, lifecycle };
}
