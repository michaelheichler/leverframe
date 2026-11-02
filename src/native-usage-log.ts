import type { ResponseUsage } from './http-proxy/response-usage.js';
import { writeInferenceResponseLifecycleLog } from './trace-log.js';

export function nativeUsageLogger(logPath: string | undefined, requestId: string, modelId: string, provider: string) {
  if (!logPath) return undefined;
  return (usage: ResponseUsage, upstreamMs: number, accountId?: string): void => {
    writeInferenceResponseLifecycleLog(logPath, {
      event: 'response_usage', requestId, modelId, provider, route: 'passthrough',
      durationMs: upstreamMs, accountId, ...usage,
    });
  };
}
