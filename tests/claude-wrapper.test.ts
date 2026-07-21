import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeWrapperContractPath } from '../src/claude-wrapper.js';

describe('looksLikeWrapperContractPath', () => {
  let temp: string;

  it('classifies an existing non-executable file as a wrapper contract path', () => {
    temp = mkdtempSync(join(tmpdir(), 'leverframe-wrapper-'));
    const target = join(temp, 'claude-lostexec');
    writeFileSync(target, 'binary-ish', { mode: 0o600 });
    chmodSync(target, 0o600); // explicitly not executable
    expect(looksLikeWrapperContractPath(target)).toBe(true);
  });

  it('classifies a path-like string (with separator) even when it does not exist', () => {
    expect(looksLikeWrapperContractPath('/usr/local/bin/claude')).toBe(true);
    expect(looksLikeWrapperContractPath('./claude')).toBe(true);
    expect(looksLikeWrapperContractPath('bin/claude')).toBe(true);
  });

  it('classifies the bare basename "claude" as a wrapper path (not a CLI flag)', () => {
    expect(looksLikeWrapperContractPath('claude')).toBe(true);
    expect(looksLikeWrapperContractPath('claude.exe')).toBe(true);
  });

  it('does not classify ordinary Claude CLI flags as wrapper paths', () => {
    expect(looksLikeWrapperContractPath('-p')).toBe(false);
    expect(looksLikeWrapperContractPath('--help')).toBe(false);
    expect(looksLikeWrapperContractPath('sonnet')).toBe(false);
    expect(looksLikeWrapperContractPath('continue')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(looksLikeWrapperContractPath('')).toBe(false);
  });

  if (temp) {
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
