import {
  runIsolatedKeyringOperation,
  type KeyringOperation,
  type KeyringResult,
} from '../credential-store.js';
import { randomBytes } from 'node:crypto';
import { withCredentialMutationLock } from '../registry/lock.js';

export const TRUSTED_METADATA_KEYRING_SERVICE = 'leverframe-trusted-metadata-v1';
export const TRUSTED_METADATA_KEYRING_ACCOUNT = 'workspace-digest-key';

const KEY_PATTERN = /^v1_[0-9a-f]{64}$/;
const KEYRING_LOCK_NAMESPACE = 'trusted-metadata:workspace-digest-key';

export type WorkspaceDigestKeyringOperation = (operation: KeyringOperation) => Promise<KeyringResult>;

export class WorkspaceDigestKeyUnavailableError extends Error {
  constructor() {
    super('trusted metadata workspace digest key is unavailable');
    this.name = 'WorkspaceDigestKeyUnavailableError';
  }
}

export class WorkspaceDigestKeyIntegrityError extends Error {
  constructor() {
    super('trusted metadata workspace digest key failed integrity validation');
    this.name = 'WorkspaceDigestKeyIntegrityError';
  }
}

function isValidKey(value: string | null): value is string {
  return value !== null && KEY_PATTERN.test(value);
}

function keyringRead(operation: WorkspaceDigestKeyringOperation): Promise<KeyringResult> {
  return operation({
    operation: 'read',
    service: TRUSTED_METADATA_KEYRING_SERVICE,
    account: TRUSTED_METADATA_KEYRING_ACCOUNT,
  });
}

function keyringWrite(operation: WorkspaceDigestKeyringOperation, value: string): Promise<KeyringResult> {
  return operation({
    operation: 'write',
    service: TRUSTED_METADATA_KEYRING_SERVICE,
    account: TRUSTED_METADATA_KEYRING_ACCOUNT,
    value,
  });
}

async function readOrCreateUnlocked(operation: WorkspaceDigestKeyringOperation): Promise<string> {
  const existing = await keyringRead(operation);
  if (!existing.ok) throw new WorkspaceDigestKeyUnavailableError();
  if (existing.value !== null) {
    if (!isValidKey(existing.value)) throw new WorkspaceDigestKeyIntegrityError();
    return existing.value;
  }

  const candidate = `v1_${randomBytes(32).toString('hex')}`;
  const written = await keyringWrite(operation, candidate);
  if (!written.ok) throw new WorkspaceDigestKeyUnavailableError();
  const verified = await keyringRead(operation);
  if (!verified.ok) throw new WorkspaceDigestKeyUnavailableError();
  if (verified.value !== candidate) throw new WorkspaceDigestKeyIntegrityError();
  return candidate;
}

export function readOrCreateWorkspaceDigestKey(options: {
  keyringOperation?: WorkspaceDigestKeyringOperation;
} = {}): Promise<string> {
  const operation = options.keyringOperation ?? (input => runIsolatedKeyringOperation(input));
  return withCredentialMutationLock(KEYRING_LOCK_NAMESPACE, () => readOrCreateUnlocked(operation));
}