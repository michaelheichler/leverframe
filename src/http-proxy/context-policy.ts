import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync } from 'node:fs';
import { extractClaudeSessionId, type AnthropicRequest } from '../sdk-adapter.js';
import { wireClientDisconnectAbort } from '../request-pipeline.js';
import { applyRequestContextPolicy, formatRequestPolicyOutcome } from '../context/request-policy.js';
import { getProxyDebugLogPath } from '../log-paths.js';

export async function applyHttpPassthroughPolicy(req: IncomingMessage, res: ServerResponse, rawBody: Buffer, modelId: string, debug: boolean, logPath?: string): Promise<Buffer> {
  let request: AnthropicRequest;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as AnthropicRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) return rawBody;
  } catch {
    return rawBody;
  }
  const { controller, detach } = wireClientDisconnectAbort(req, res);
  try {
    const header = req.headers['x-claude-code-session-id'];
    const sessionId = extractClaudeSessionId(request, Array.isArray(header) ? header[0] : header);
    const started = performance.now();
    const result = await applyRequestContextPolicy({ request, sessionId, routeIdentity: `anthropic:${modelId}`, contextWindow: undefined, signal: controller.signal });
    if (debug) {
      try {
        appendFileSync(logPath ?? getProxyDebugLogPath(), `${formatRequestPolicyOutcome(result, performance.now() - started)}\n`, { mode: 0o600 });
      } catch {
        return rawBody;
      }
    }
    return rawBody;
  } finally {
    detach();
  }
}
