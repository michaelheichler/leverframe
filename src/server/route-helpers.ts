import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { sendJson, readBody } from '../http-utils.js';
import {
  gatewayDisplayName,
  type ModelCatalog,
  type ServerModelInfo,
  upstreamModelId,
} from './models.js';
import {
  writeInferenceRequestLog,
  writeInferenceResponseErrorLog,
  writeWebSocketDiagnosticLog,
  type InferenceRequestLogEntry,
} from '../trace-log.js';
import { createLanguageModel } from '../provider-factory.js';
import {
  sdkUpstreamErrorDetails,
  upstreamHttpStatus,
} from '../upstream-error.js';
import type { ServerOptions } from './router.js';
import { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import {
  ExecutionRecoveryBlockedError,
  EXECUTION_ID_HEADER,
  EXECUTION_GENERATION_HEADER,
  type ExecutionTrackingHandle,
} from '../execution-tracking.js';
import { workspaceOrSessionHash } from '../checkpoint-store.js';
import { loadCheckpoint, type DigestableMessage } from '../execution-checkpoint.js';
import { buildProviderCapabilities } from '../provider-capabilities.js';
import { revalidateCustomEndpointUrl, type UrlSecurityResult } from '../registry/url-security.js';

export type JsonBody = Record<string, any>;
export type PLog = (msg: string | (() => string)) => void;

export function auditInference(options: ServerOptions, entry: InferenceRequestLogEntry): void {
  if (options.inferenceLogPath) writeInferenceRequestLog(options.inferenceLogPath, entry);
}

export function inferenceProvider(model: ServerModelInfo): string {
  return model.providerId ?? String(model.sourceBackend);
}

export function requestHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function executionCapabilities(model: ServerModelInfo, body: JsonBody) {
  const supported = model.supportedParameters ?? [];
  return buildProviderCapabilities({
    providerId: inferenceProvider(model),
    supportedParameters: supported,
    streaming: true,
    tools: Array.isArray(body.tools) || supported.includes('tools'),
    reasoning: model.reasoning,
    websocket: model.preferWebSockets,
    clientManagedState: true,
  });
}

export function auditSdkError(
  options: ServerOptions,
  requestedModelId: string,
  model: ServerModelInfo,
  err: unknown,
  message: string,
): number {
  const details = sdkUpstreamErrorDetails(err);
  const statusCode = details?.statusCode ?? upstreamHttpStatus(err, message);
  if (options.inferenceLogPath && statusCode >= 400) {
    writeInferenceResponseErrorLog(options.inferenceLogPath, {
      modelId: requestedModelId,
      provider: inferenceProvider(model),
      route: 'translated',
      statusCode,
      errorContent: details?.errorContent ?? message,
      isRetryable: details?.isRetryable,
      attemptCount: details?.attemptCount,
    });
  }
  return statusCode;
}

export function digestableMessageFrom(message: unknown): DigestableMessage | undefined {
  if (!message || typeof message !== 'object' || typeof (message as JsonBody).role !== 'string') return undefined;
  return { role: (message as JsonBody).role, content: (message as JsonBody).content };
}

export function toDigestableMessages(body: JsonBody): DigestableMessage[] {
  const messages: DigestableMessage[] = [];
  if (typeof body.system === 'string' && body.system) messages.push({ role: 'system', content: body.system });
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const digestable = digestableMessageFrom(message);
      if (digestable) messages.push(digestable);
    }
  }
  return messages;
}

export function toolResultFromBlock(block: unknown): { toolUseId: string; content: string } | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const record = block as JsonBody;
  if (record.type !== 'tool_result' || typeof record.tool_use_id !== 'string') return undefined;
  const raw = record.content;
  return { toolUseId: record.tool_use_id, content: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') };
}

export function extractAnthropicToolResults(body: JsonBody): Array<{ toolUseId: string; content: string }> {
  const results: Array<{ toolUseId: string; content: string }> = [];
  if (!Array.isArray(body.messages)) return results;
  for (const message of body.messages) {
    const content = (message as JsonBody | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const result = toolResultFromBlock(block);
      if (result) results.push(result);
    }
  }
  return results;
}

export function extractOpenAiToolResults(body: JsonBody): Array<{ toolUseId: string; content: string }> {
  const results: Array<{ toolUseId: string; content: string }> = [];
  if (!Array.isArray(body.messages)) return results;
  for (const message of body.messages) {
    const record = message as JsonBody | undefined;
    if (record?.role === 'tool' && typeof record.tool_call_id === 'string') {
      const raw = record.content;
      results.push({ toolUseId: record.tool_call_id, content: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') });
    }
  }
  return results;
}

interface RespondExecutionRecoveryBlockedInput {
  res: ServerResponse;
  sessionKey: string;
  requestedExecutionId: string | undefined;
  error: ExecutionRecoveryBlockedError;
}

export function respondExecutionRecoveryBlocked(input: RespondExecutionRecoveryBlockedInput): void {
  const { res, sessionKey, requestedExecutionId, error } = input;
  if (requestedExecutionId) {
    const scopeHash = workspaceOrSessionHash(sessionKey);
    const checkpoint = loadCheckpoint(scopeHash, requestedExecutionId);
    res.setHeader(EXECUTION_ID_HEADER, requestedExecutionId);
    res.setHeader(EXECUTION_GENERATION_HEADER, String(checkpoint.generation));
  }
  sendJson(res, error.statusCode, {
    error: { type: 'execution_recovery_blocked', message: error.decision.reason },
    recoveryDecision: error.decision.kind,
    ambiguousToolCallIds: error.decision.ambiguousToolCallIds,
  });
}

export function applyExecutionHeaders(res: ServerResponse, tracking: ExecutionTrackingHandle): void {
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(tracking.headers)) res.setHeader(name, value);
}

export function attachAnthropicObserver(tracking: ExecutionTrackingHandle, clientWantsStream: boolean): (text: string) => void {
  return clientWantsStream
    ? text => tracking.observeAnthropicSseText(text)
    : text => {
        try {
          tracking.observeNonStreamAnthropic(JSON.parse(text));
        } catch {

        }
      };
}

export function openAiEffort(body: JsonBody): string | undefined {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    return body.reasoning_effort.trim();
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object' && typeof reasoning.effort === 'string' && reasoning.effort.trim()) {
    return reasoning.effort.trim();
  }
  return undefined;
}
export async function revalidateEndpointUrl(url: string): Promise<UrlSecurityResult> {
  const isHttp = url.trim().toLowerCase().startsWith('http://');
  return revalidateCustomEndpointUrl(url, { allowInsecureLocal: isHttp });
}
export function lookupModel(res: ServerResponse, catalog: ModelCatalog, modelId: unknown): ServerModelInfo | null {
  if (typeof modelId !== 'string') {
    sendJson(res, 400, { error: { message: 'Request body must include a model string' } });
    return null;
  }

  const model = catalog.get(modelId);
  if (!model) {
    sendJson(res, 400, { error: { message: `Unknown model: ${modelId}` } });
    return null;
  }

  return model;
}

export function providerRuntimeRouteKey(
  model: ServerModelInfo,
  npm: string,
  baseURL: string | undefined,
): string {
  return [
    model.providerId ?? model.sourceBackend,
    model.oauthAccountId ?? '',
    model.id,
    upstreamModelId(model),
    npm,
    baseURL ?? '',
  ].join('\x1f');
}

export async function getOrInitLanguageModel(
  modelCache: ProviderRuntimeCache<LanguageModel>,
  model: ServerModelInfo,
  npm: string,
  baseURL: string | undefined,
  apiKey: string,
  webSocketDiagnosticsLogPath?: string,
): Promise<LanguageModel> {
  const routeKey = providerRuntimeRouteKey(model, npm, baseURL);
  let credential = modelCache.snapshot(routeKey, apiKey);

  if (model.authType !== 'oauth' && credential.credential !== apiKey) {
    credential = await modelCache.adopt(routeKey, credential.credential, apiKey);
  }
  return modelCache.getHandle(routeKey, credential, handleCredential => createLanguageModel({
    npm,
    modelId: upstreamModelId(model),
    apiKey: handleCredential.credential,
    baseURL,
    providerId: model.providerId ?? model.sourceBackend,
    authType: model.authType,
    oauthAccountId: model.oauthAccountId,
    headers: model.headers,
    useResponsesLite: model.useResponsesLite,
    preferWebSockets: model.preferWebSockets,
    minimalClientVersion: model.minimalClientVersion,
    onWebSocketDiagnostic: webSocketDiagnosticsLogPath
      ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
      : undefined,
  }));
}

export function getResponseModelId(bodyModel: unknown, model: ServerModelInfo, options: ServerOptions): string {
  if (typeof bodyModel === 'string' && options.aliasNames?.has(bodyModel)) return bodyModel;
  return options.gateway?.maskGatewayIds
    ? gatewayDisplayName(model, options.gateway)
    : (typeof bodyModel === 'string' ? bodyModel : model.id);
}

export async function readJson(req: IncomingMessage): Promise<JsonBody | null> {
  try {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}
