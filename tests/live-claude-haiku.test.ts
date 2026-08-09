import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const liveCompactionEnabled = process.env['LEVERFRAME_LIVE_CLAUDE_COMPACTION_TEST'] === '1';
const haikuModel = process.env['LEVERFRAME_LIVE_CLAUDE_MODEL'] ?? '';
const HAIKU_MODEL_PATTERN = /^claude-haiku-[a-z0-9.-]+$/;

describe('live Claude Code compaction smoke test', () => {
  const runLiveTest = liveCompactionEnabled ? it : it.skip;

  runLiveTest('uses only an explicitly selected Haiku model', () => {
    expect(haikuModel).toMatch(HAIKU_MODEL_PATTERN);
    const output = execFileSync('claude', [
      '-p',
      'Summarize this sentence in plain text only: Leverframe uses a local test fixture.',
      '--model',
      haikuModel,
    ], { encoding: 'utf8' });
    expect(output.trim()).not.toBe('');
  }, 120_000);
});
