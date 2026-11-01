import { handleSdkAnthropicMessages } from './anthropic-sdk-route.js';
import { handleNativeAnthropicMessages } from './anthropic-native-route.js';
import type { NativeRequestContext } from './anthropic-native-route.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { sendJson } from '../http-utils.js';
import {
  writeWebSocketDiagnosticRequestLog,
} from '../trace-log.js';
import type { ServerOptions } from './router.js';
import {
  extractClaudeSessionId,
  type AnthropicRequest,
} from '../sdk-adapter.js';
import { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import {
  beginExecutionTracking,
  reconcileIncomingToolResults,
  ExecutionRecoveryBlockedError,
  EXECUTION_ID_HEADER,
  type ExecutionTrackingHandle,
} from '../execution-tracking.js';
import { createRequestExecutionContext } from '../request-execution-context.js';
import { resolveExecutionSessionKey } from '../execution-session-key.js';
import { attachRequestExecutionDisposal, wireClientDisconnectAbort } from '../request-pipeline.js';
import {
  executionCapabilities,
  extractAnthropicToolResults,
  inferenceProvider,
  lookupModel,
  readJson,
  requestHeader,
  respondExecutionRecoveryBlocked,
  toDigestableMessages,
  type PLog,
} from './route-helpers.js';
import { validateAnthropicMessagesRoute } from './route-validation.js';

export async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: ProviderRuntimeCache<LanguageModel>,
  plog: PLog,
): Promise<void> {
  const parsed = await readAnthropicRoute(req, res, options, plog);
  if (!parsed) return;
  const { body, model } = parsed;
  const passthrough = model.modelFormat === 'anthropic' && model.providerId !== 'github-copilot';
  const requestId = randomUUID();
  const claudeSessionIdHeader = Array.isArray(req.headers['x-claude-code-session-id'])
    ? req.headers['x-claude-code-session-id'][0]
    : req.headers['x-claude-code-session-id'];
  const claudeSessionId = extractClaudeSessionId(body as AnthropicRequest, claudeSessionIdHeader);
  const executionSessionKey = resolveExecutionSessionKey({
    claudeSessionId,
    provider: inferenceProvider(model),
    model: model.id,
  });
  const { controller: clientAbort, detach: detachClientAbort } = wireClientDisconnectAbort(req, res);

  try {
    const requestExecution = createRequestExecutionContext({
      requestId,
      provider: inferenceProvider(model),
      model: model.id,
      correlationId: requestId,
      signal: clientAbort.signal,
    });
    attachRequestExecutionDisposal(res, requestExecution);
    requestExecution.startResolving();
    const tracking = beginAnthropicTracking({ req, res, body, model, requestId, executionSessionKey, passthrough });
    if (!tracking) return;
    if (options.webSocketDiagnosticsLogPath) {
      writeWebSocketDiagnosticRequestLog(options.webSocketDiagnosticsLogPath, {
        requestId,
        claudeSessionId,
        provider: inferenceProvider(model),
        route: passthrough ? 'passthrough' : 'translated',
        headers: req.headers,
        body,
      });
    }

    plog(() => `anthropic-messages model=${body.model} format=${model.modelFormat} npm=${model.npm ?? 'none'} stream=${body.stream}`);

    if (passthrough) {
      await handleNativeAnthropicMessages({
        req, res, options, modelCache, plog, body, model, requestId, claudeSessionId,
        clientAbort, requestExecution, tracking,
      });
      return;
    }

    if (model.modelFormat === 'openai' || (model.modelFormat === 'anthropic' && !passthrough)) {
      await handleSdkAnthropicMessages({
        req, res, options, modelCache, plog, body, model, requestId, claudeSessionId,
        clientAbort, requestExecution, tracking,
      });
      return;
    }

    sendJson(res, 400, { error: { message: `Unsupported model format: ${model.modelFormat}` } });
  } finally {
    detachClientAbort();
  }
}

async function readAnthropicRoute(req: IncomingMessage, res: ServerResponse, options: ServerOptions, plog: PLog) {
  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }
  if (!Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
    return;
  }
  const model = lookupModel(res, options.catalog, body.model);
  if (!model) {
    plog(`model not found: ${body.model}`);
    return;
  }
  const routeValidation = await validateAnthropicMessagesRoute(model);
  if (routeValidation) {
    sendJson(res, 400, { error: { message: routeValidation } });
    return;
  }
  return { body, model };
}

function beginAnthropicTracking(context: Pick<NativeRequestContext, 'req' | 'res' | 'body' | 'model' | 'requestId'> & {
  executionSessionKey: string;
  passthrough: boolean;
}): ExecutionTrackingHandle | undefined {
  const { req, res, body, model, requestId, executionSessionKey, passthrough } = context;
  reconcileIncomingToolResults({ sessionKey: executionSessionKey, toolResults: extractAnthropicToolResults(body) });
  try {
    return beginExecutionTracking({
      sessionKey: executionSessionKey,
      executionId: requestHeader(req, EXECUTION_ID_HEADER),
      requestId,
      provider: inferenceProvider(model),
      model: body.model,
      route: passthrough ? 'passthrough' : 'translated',
      messages: toDigestableMessages(body),
      toolResults: extractAnthropicToolResults(body),
      capabilities: executionCapabilities(model, body),
    });
  } catch (error) {
    if (error instanceof ExecutionRecoveryBlockedError) {
      respondExecutionRecoveryBlocked({ res, sessionKey: executionSessionKey, requestedExecutionId: requestHeader(req, EXECUTION_ID_HEADER), error });
      return;
    }
    throw error;
  }
}
