import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderTransportError } from '../src/provider-error.js';
import { emptyCompletionError } from '../src/sdk-completion.js';
import { sdkUpstreamErrorDetails } from '../src/upstream-error.js';
import { writeInferenceResponseErrorLog } from '../src/trace-log.js';

describe('completion error diagnostics', () => {
  it('writes normalized and raw finish reasons with cache-inclusive token counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-completion-diagnostic-'));
    const path = join(dir, 'inference.jsonl');
    try {
      const error = emptyCompletionError('test-model', {
        input_tokens: 500,
        cache_read_input_tokens: 114_500,
        cache_creation_input_tokens: 2_000,
        output_tokens: 100,
      }, 272_000, 'other', false, 'provider_reason');
      const details = sdkUpstreamErrorDetails(error);

      writeInferenceResponseErrorLog(path, {
        modelId: 'test-model',
        provider: 'openai-oauth',
        route: 'translated',
        statusCode: details?.statusCode ?? 502,
        errorContent: details?.errorContent,
        completion: details?.completion,
      });

      const entry = JSON.parse(readFileSync(path, 'utf8').trim());
      expect(entry.completion).toEqual({
        finishReason: 'other',
        rawFinishReason: 'provider_reason',
        totalInputTokens: 117_000,
        uncachedInputTokens: 500,
        cachedInputTokens: 116_500,
        outputTokens: 100,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes unrecognized fields from persisted completion diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-completion-diagnostic-private-'));
    const path = join(dir, 'inference.jsonl');
    try {
      const error = new ProviderTransportError({
        provider: 'sdk-adapter',
        phase: 'completion',
        httpStatus: 502,
        retryable: true,
        outputEmitted: false,
        safeMessage: 'Upstream returned no content.',
        diagnosticDetail: JSON.stringify({
          finishReason: 'stop',
          rawFinishReason: 'end_turn',
          totalInputTokens: 10,
          requestContent: 'private prompt text',
        }),
      });
      const details = sdkUpstreamErrorDetails(error);

      writeInferenceResponseErrorLog(path, {
        modelId: 'test-model', provider: 'openai-oauth', route: 'translated', statusCode: 502,
        completion: details?.completion,
      });

      const raw = readFileSync(path, 'utf8');
      expect(JSON.parse(raw).completion).toEqual({
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
        totalInputTokens: 10,
      });
      expect(raw).not.toContain('private prompt text');
      expect(raw).not.toContain('requestContent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
