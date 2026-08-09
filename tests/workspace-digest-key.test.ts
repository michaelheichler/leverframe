import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRUSTED_METADATA_KEYRING_ACCOUNT,
  TRUSTED_METADATA_KEYRING_SERVICE,
  WorkspaceDigestKeyIntegrityError,
  WorkspaceDigestKeyUnavailableError,
  readOrCreateWorkspaceDigestKey,
  type WorkspaceDigestKeyringOperation,
} from '../src/context/workspace-digest-key.js';

const validKey = `v1_${'a'.repeat(64)}`;

afterEach(() => vi.unstubAllEnvs());

function operationWithValue(value: string | null): WorkspaceDigestKeyringOperation {
  let stored = value;
  return async operation => {
    expect(operation.service).toBe(TRUSTED_METADATA_KEYRING_SERVICE);
    expect(operation.account).toBe(TRUSTED_METADATA_KEYRING_ACCOUNT);
    if (operation.operation === 'read') return { ok: true, value: stored };
    if (operation.operation === 'write') {
      stored = operation.value;
      return { ok: true, value: null };
    }
    throw new Error('unexpected operation');
  };
}

describe('workspace digest key', () => {
  it('returns an existing valid key without writing', async () => {
    const operation = vi.fn(operationWithValue(validKey));

    await expect(readOrCreateWorkspaceDigestKey({ keyringOperation: operation })).resolves.toBe(validKey);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('creates and verifies a missing key', async () => {
    const operation = vi.fn(operationWithValue(null));

    await expect(readOrCreateWorkspaceDigestKey({ keyringOperation: operation })).resolves.toMatch(/^v1_[0-9a-f]{64}$/);
    expect(operation.mock.calls.map(([input]) => input.operation)).toEqual(['read', 'write', 'read']);
  });

  it('rejects malformed existing secrets and redacts keyring failures', async () => {
    await expect(readOrCreateWorkspaceDigestKey({ keyringOperation: operationWithValue('raw-secret') }))
      .rejects.toBeInstanceOf(WorkspaceDigestKeyIntegrityError);
    await expect(readOrCreateWorkspaceDigestKey({ keyringOperation: async () => ({ ok: false, error: 'raw-secret-value' }) }))
      .rejects.toBeInstanceOf(WorkspaceDigestKeyUnavailableError);
  });

  it('rejects write failures and verification mismatches without fallback storage', async () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-trusted-metadata-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    const writeFailure: WorkspaceDigestKeyringOperation = async input =>
      input.operation === 'read' ? { ok: true, value: null } : { ok: false, error: 'write failed' };
    const mismatch: WorkspaceDigestKeyringOperation = async input =>
      input.operation === 'read' ? { ok: true, value: input.operation === 'read' ? null : null } : { ok: true, value: null };

    await expect(readOrCreateWorkspaceDigestKey({ keyringOperation: writeFailure }))
      .rejects.toBeInstanceOf(WorkspaceDigestKeyUnavailableError);
    await expect(readOrCreateWorkspaceDigestKey({ keyringOperation: mismatch }))
      .rejects.toBeInstanceOf(WorkspaceDigestKeyIntegrityError);
    expect(existsSync(join(home, 'credentials-fallback.json'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it('serializes concurrent callers through the mutation lock', async () => {
    let stored: string | null = null;
    let writes = 0;
    const operation: WorkspaceDigestKeyringOperation = async input => {
      if (input.operation === 'read') return { ok: true, value: stored };
      if (input.operation !== 'write') throw new Error('unexpected operation');
      writes += 1;
      stored = input.value;
      return { ok: true, value: null };
    };

    const values = await Promise.all([
      readOrCreateWorkspaceDigestKey({ keyringOperation: operation }),
      readOrCreateWorkspaceDigestKey({ keyringOperation: operation }),
    ]);
    expect(values[0]).toBe(values[1]);
    expect(writes).toBe(1);
  });
});