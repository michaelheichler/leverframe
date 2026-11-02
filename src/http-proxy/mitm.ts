import * as http from 'node:http';
import type { ProxyHandle, ProxyRoute } from '../proxy.js';
import { readClaudeCodeAuthMaterial } from '../claude-code-credentials.js';
import { HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY } from '../env.js';
import { anthropicMessagesEndpoint } from '../anthropic-endpoints.js';
import { writeInferenceResponseErrorLog, writeInferenceResponseLifecycleLog } from '../trace-log.js';
import { rewriteUpstreamAuthHeaders } from './claude-passthrough-auth.js';
import { applyHttpPassthroughPolicy } from './context-policy.js';
import { decideHttpProxyRoute } from './routing-decision.js';
import { forwardRawAnthropicRequest, forwardToAdapter, requestHeadersWithoutProxyHeaders } from './forward.js';
import type { HttpProxyOptions } from './server.js';

interface MitmContext {
  options: HttpProxyOptions;
  routesById: Map<string, ProxyRoute>;
  adapter: ProxyHandle | null;
  adapterAgent: http.Agent;
  origin: URL;
}
type PassthroughDecision = Extract<ReturnType<typeof decideHttpProxyRoute>, { action: 'passthrough-messages' }>;

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function usesPlaceholder(headers: http.IncomingHttpHeaders): boolean {
  const value = (name: string) => {
    const raw = headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  if (value('x-api-key')?.trim() === HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY) return true;
  const authorization = value('authorization');
  return /^Bearer\s+(\S+)/i.exec(authorization?.trim() ?? '')?.[1] === HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY;
}

function missingCredential(res: http.ServerResponse, decision: PassthroughDecision): void {
  const message = 'Claude --bare placeholder cannot call Anthropic and no Claude Code '
    + 'OAuth/API credential was found. Run `claude /login` or set ANTHROPIC_API_KEY.';
  const errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } });
  if (decision.lifecycle) writeInferenceResponseErrorLog(decision.lifecycle.logPath, {
    requestId: decision.requestId, modelId: decision.modelId, provider: 'anthropic',
    route: 'passthrough', statusCode: 400, errorContent: errorBody,
  });
  res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(errorBody)) });
  res.end(errorBody);
}

async function passthrough(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer, decision: PassthroughDecision, context: MitmContext): Promise<void> {
  const { options, origin } = context;
  const lifecycle = decision.lifecycle;
  const policyBody = anthropicMessagesEndpoint(req.url) === 'messages'
    ? await applyHttpPassthroughPolicy(req, res, rawBody, decision.modelId, options.debug ?? false, options.debugLogPath)
    : rawBody;
  if (req.aborted || res.destroyed || res.writableEnded) return;
  let upstreamHeaders: string[] | undefined;
  if (usesPlaceholder(req.headers)) {
    const auth = await (options.resolveClaudeCodeAuth ?? readClaudeCodeAuthMaterial)();
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!auth) { missingCredential(res, decision); return; }
    upstreamHeaders = rewriteUpstreamAuthHeaders(requestHeadersWithoutProxyHeaders(req), auth);
  }
  await forwardRawAnthropicRequest(req, res, policyBody, origin, options.anthropicRejectUnauthorized ?? true,
    lifecycle ? (statusCode, errorContent) => writeInferenceResponseErrorLog(lifecycle.logPath, {
      requestId: decision.requestId, modelId: decision.modelId, provider: 'anthropic', route: 'passthrough', statusCode, errorContent,
    }) : undefined,
    lifecycle ? usage => writeInferenceResponseLifecycleLog(lifecycle.logPath, {
      event: 'response_usage', requestId: decision.requestId, modelId: decision.modelId,
      provider: 'anthropic', route: 'passthrough', ...usage,
    }) : undefined, lifecycle, upstreamHeaders);
}

export async function handleMitmRequest(req: http.IncomingMessage, res: http.ServerResponse, context: MitmContext): Promise<void> {
  let rawBody: Buffer;
  try { rawBody = await readRawBody(req); } catch (err) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end(err instanceof Error ? err.message : String(err));
    return;
  }
  const { options, routesById, adapter, adapterAgent, origin } = context;
  const decision = decideHttpProxyRoute({
    method: req.method, url: req.url, headers: req.headers, rawBody, routesById,
    hasAdapter: adapter !== null, inferenceLogPath: options.inferenceLogPath,
    webSocketDiagnosticsLogPath: options.webSocketDiagnosticsLogPath,
    responseProgressIntervalMs: options.responseProgressIntervalMs,
  });
  switch (decision.action) {
    case 'translated':
      if (!adapter) throw new Error('HTTP proxy route decision selected an adapter that is no longer running');
      await forwardToAdapter(req, res, rawBody, adapter, options.adapterRequest ?? http.request, adapterAgent, decision.lifecycle);
      return;
    case 'passthrough-messages':
      await passthrough(req, res, rawBody, decision, context);
      return;
    case 'rejected': {
      const body = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: decision.message } });
      res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    case 'raw':
      await forwardRawAnthropicRequest(req, res, rawBody, origin, options.anthropicRejectUnauthorized ?? true);
      return;
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled HTTP proxy route decision: ${JSON.stringify(exhaustive)}`);
    }
  }
}
