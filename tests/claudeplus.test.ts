import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('verifies claudeplus proxy preparation, context handoff, settings, and cache mode', () => {
  const output = execFileSync('python3', ['-B', '-I', '-S', join(import.meta.dirname, 'claudeplus_test.py')], {
    encoding: 'utf8', stdio: 'pipe',
  });
  expect(output).toBe('');
});
