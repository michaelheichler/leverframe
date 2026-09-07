import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const parse = vi.hoisted(() => vi.fn());
const disable = vi.hoisted(() => vi.fn());

vi.mock('node-lief', () => ({
  default: {
    logging: { disable },
    parse,
  },
}));

import { resolveNixBinaryWrapper } from '../src/claude-bundle-native-wrapper.js';

const roots: string[] = [];

afterEach(() => {
  parse.mockReset();
  disable.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binaryFixture(format: 'ELF' | 'MachO', text: string): object {
  const content = Buffer.from(text, 'utf8');
  const symbols = () => [{ name: 'execv' }];
  if (format === 'ELF') {
    return {
      format,
      symbols,
      sections: () => [{ name: '.rodata', content }],
    };
  }
  return {
    format,
    symbols,
    getSegment: () => ({ getSection: () => ({ content }) }),
  };
}

function wrapperFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-native-wrapper-'));
  roots.push(root);
  const path = join(root, 'claude-wrapper');
  writeFileSync(path, Buffer.from('wrapper'));
  return path;
}

describe('Nix native wrapper resolution', () => {
  it.each([
    {
      name: 'unquoted makeCWrapper path',
      format: 'ELF' as const,
      text: 'makeCWrapper /nix/store/abc123-claude/bin/claude\0--argv0\0',
    },
    {
      name: 'fallback Nix path',
      format: 'MachO' as const,
      text: 'wrapper target /nix/store/def456-claude/bin/claude\0next C string\0',
    },
  ])('stops $name at the C-string terminator', ({ format, text }) => {
    const binaryPath = wrapperFixture();
    parse.mockReturnValue(binaryFixture(format, text));

    expect(resolveNixBinaryWrapper(binaryPath)).toBe(
      format === 'ELF'
        ? '/nix/store/abc123-claude/bin/claude'
        : '/nix/store/def456-claude/bin/claude',
    );
  });
});
