import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInferenceResponseLifecycleLog } from '../src/trace-log.js';

it('records known cache TTL usage and omits unknown token measurements', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-usage-audit-'));
  const path = join(home, 'inference.jsonl');

  try {
    writeInferenceResponseLifecycleLog(path, {
      event: 'response_usage', requestId: 'fixture-request', modelId: 'fixture-model',
      provider: 'anthropic', route: 'translated', usageStage: 'message_delta',
      inputTokens: 24, outputTokens: 3, cacheCreationInputTokens: 7,
      cacheCreation5mInputTokens: 4, cacheCreation1hInputTokens: 3,
      cacheReadInputTokens: 5, totalInputTokens: 36,
    });
    writeInferenceResponseLifecycleLog(path, {
      event: 'response_usage', requestId: 'fixture-request', modelId: 'fixture-model',
      provider: 'anthropic', route: 'translated', usageStage: 'message_start',
      inputTokens: undefined, outputTokens: undefined, cacheCreationInputTokens: undefined,
      cacheCreation5mInputTokens: undefined, cacheCreation1hInputTokens: undefined,
      cacheReadInputTokens: undefined, totalInputTokens: undefined,
    });

    const [known, unknown] = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(known).toMatchObject({
      inputTokens: 24, outputTokens: 3, cacheCreationInputTokens: 7,
      cacheCreation5mInputTokens: 4, cacheCreation1hInputTokens: 3,
      cacheReadInputTokens: 5, totalInputTokens: 36,
    });
    expect(unknown).not.toHaveProperty('inputTokens');
    expect(unknown).not.toHaveProperty('totalInputTokens');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
