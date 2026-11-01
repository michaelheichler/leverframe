import type { ServerResponse } from 'node:http';
import { classifyPoolFailure, dispatchWithPool, poolExhaustionMessage } from './account-pool-dispatch.js';
import { anthropicError } from './proxy-response.js';
import { relayAnthropicMessages } from './upstream-forward.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { recordObservation } from './account-pool.js';
import { anthropicCapacity } from './account-pool-telemetry.js';

function reportNativeFailure(options: {
  res: ServerResponse; signal: AbortSignal; lifecycle: RequestExecutionObserver; onFailure?: () => void;
}, error: unknown): void {
  if (options.signal.aborted) return;
  options.lifecycle.fail(error);
  options.onFailure?.();
  anthropicError(options.res, 502, error instanceof Error ? error.message : String(error));
}

export async function dispatchNativePool(options: {
  res: ServerResponse;
  providerId: string;
  modelId: string;
  sessionId?: string;
  targetUrl: string;
  body: Record<string, unknown>;
  stream: boolean;
  inboundBeta?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  lifecycle: RequestExecutionObserver;
  responseModelId?: string;
  onObservedText?: (text: string) => void;
  onFailure?: () => void;
  onUpstreamError?: (statusCode: number, body: string) => void;
}): Promise<void> {
  const result = await dispatchWithPool({
    pool: { providerId: options.providerId, modelId: options.modelId, billingType: 'api' },
    sessionId: options.sessionId,
    dispatch: async binding => {
      const rejection = await relayAnthropicMessages(options.res, options.targetUrl, options.body, binding.apiKey, options.stream, {
        inboundBeta: options.inboundBeta, authType: 'api', extraHeaders: options.headers, signal: options.signal,
        lifecycle: options.lifecycle, responseModelId: options.responseModelId, deferRejection: true,
        onObservedText: options.onObservedText,
        onResponseHeaders: async headers => {
          const now = Date.now();
          for (const observation of anthropicCapacity(headers, binding.account.id, now)) {
            await recordObservation({
              pool: { providerId: options.providerId, modelId: options.modelId, billingType: 'api' }, observation, now,
              generation: binding.generation,
            });
          }
        },
      });
      if (!rejection) return { kind: 'success' as const, value: undefined };
      const observation = classifyPoolFailure({ provider: 'anthropic', accountId: binding.account.id,
        statusCode: rejection.status, body: rejection.body, headers: rejection.headers, now: Date.now() });
      return { kind: 'failure' as const, value: rejection, observation };
    },
  }).catch(error => {
    reportNativeFailure(options, error);
    return undefined;
  });
  if (!result) return;
  if (result.kind === 'exhausted') {
    options.lifecycle.fail(new Error('Account pool exhausted'));
    options.onFailure?.();
    const message = poolExhaustionMessage(result);
    options.onUpstreamError?.(429, message);
    anthropicError(options.res, 429, message);
  } else if (result.value) {
    options.lifecycle.fail(new Error(`Upstream returned HTTP ${result.value.status}`));
    options.onFailure?.();
    options.onUpstreamError?.(result.value.status, result.value.body);
    options.res.writeHead(result.value.status, { 'Content-Type': result.value.headers.get('content-type') ?? 'application/json' });
    options.res.end(result.value.body);
  }
}
