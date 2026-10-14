import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _credentialStoreInternals,
  peekStoredCredential,
  readFallbackCredential,
  writeFallbackCredential,
  type KeyringOperation,
  type KeyringResult,
} from '../src/credential-store.js';

const ACCOUNT = 'provider:openai';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function temporaryHome(): void {
  vi.stubEnv('LEVERFRAME_HOME', join(mkdtempSync(join(tmpdir(), 'leverframe-peek-')), 'home'));
}

function stubKeyring(answer: (input: KeyringOperation) => KeyringResult): string[] {
  const operations: string[] = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    operations.push(`${input.operation}:${input.service}`);
    return answer(input);
  });
  return operations;
}

describe('peekStoredCredential', () => {
  it('returns null on a keyring integrity error without repairing the journal', async () => {
    temporaryHome();
    const operations = stubKeyring(() => ({ ok: false, error: 'integrity: keyring credential journal is corrupt' }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBeNull();
    expect(operations).toEqual(['read:leverframe']);
  });

  it('returns a legacy keyring value without migrating it', async () => {
    temporaryHome();
    const operations = stubKeyring(input => ({ ok: true, value: input.service === 'clodex' ? 'legacy-dummy' : null }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('legacy-dummy');
    expect(operations.every(operation => operation.startsWith('read:'))).toBe(true);
  });

  it('returns a fallback value without promoting it into the keyring', async () => {
    temporaryHome();
    writeFallbackCredential(ACCOUNT, 'fallback-dummy');
    const operations = stubKeyring(() => ({ ok: true, value: null }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('fallback-dummy');
    expect(operations).toEqual(['read:leverframe']);
    expect(readFallbackCredential(ACCOUNT)).toBe('fallback-dummy');
  });
});
