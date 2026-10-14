import { chmodSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _credentialStoreInternals,
  getCredentialFallbackPath,
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

function temporaryHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), 'leverframe-peek-')), 'home');
  vi.stubEnv('LEVERFRAME_HOME', home);
  return home;
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
    expect(operations).toEqual(['peek:leverframe']);
  });

  it('returns a legacy keyring value without migrating it', async () => {
    temporaryHome();
    const operations = stubKeyring(input => ({ ok: true, value: input.service === 'clodex' ? 'legacy-dummy' : null }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('legacy-dummy');
    expect(operations.every(operation => operation.startsWith('peek:'))).toBe(true);
  });

  it('returns a fallback value without promoting it into the keyring', async () => {
    temporaryHome();
    writeFallbackCredential(ACCOUNT, 'fallback-dummy');
    const operations = stubKeyring(() => ({ ok: true, value: null }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('fallback-dummy');
    expect(operations).toEqual(['peek:leverframe']);
    expect(readFallbackCredential(ACCOUNT)).toBe('fallback-dummy');
  });
});

describe('peekStoredCredential fallback snapshot', () => {
  it('creates no app home and no lock file when no fallback exists', async () => {
    const home = temporaryHome();
    stubKeyring(() => ({ ok: true, value: 'primary-dummy' }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('primary-dummy');
    expect(existsSync(home)).toBe(false);
  });

  it('leaves an existing app home with its fallback file unchanged', async () => {
    const home = temporaryHome();
    writeFallbackCredential(ACCOUNT, 'fallback-dummy');
    const before = readdirSync(home).sort();
    stubKeyring(() => ({ ok: true, value: null }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('fallback-dummy');
    expect(readdirSync(home).sort()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'returns the primary credential when the app home is unwritable',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'leverframe-peek-readonly-'));
      chmodSync(home, 0o500);
      vi.stubEnv('LEVERFRAME_HOME', home);
      stubKeyring(() => ({ ok: true, value: 'primary-dummy' }));

      try {
        await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('primary-dummy');
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')('returns the primary credential when the fallback file is unreadable', async () => {
    temporaryHome();
    writeFallbackCredential(ACCOUNT, 'fallback-dummy');
    chmodSync(getCredentialFallbackPath(), 0o644);
    stubKeyring(() => ({ ok: true, value: 'primary-dummy' }));

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('primary-dummy');
  });
});
