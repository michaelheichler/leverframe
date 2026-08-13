import { withCredentialMutationLock } from './registry/lock.js';
import {
  classifyKeyringError,
  missingDbusReason,
  runIsolatedKeyringOperation,
  type KeyringOperation,
  type KeyringResult,
} from './keyring-operations.js';
import {
  deleteFallbackCredential,
  getCredentialFallbackPath,
  readFallbackCredential,
  writeFallbackCredential,
} from './credential-fallback-store.js';

export {
  KEYRING_TIMEOUT_MS,
  buildKeyringHelperEnv,
  classifyKeyringError,
  runIsolatedKeyringOperation,
  type KeyringOperation,
  type KeyringResult,
} from './keyring-operations.js';
export {
  getCredentialFallbackPath,
  readFallbackCredential,
  writeFallbackCredential,
  deleteFallbackCredential,
} from './credential-fallback-store.js';

const KEYRING_SERVICE = 'leverframe';
const LEGACY_KEYRING_SERVICES = ['clodex', 'relay-ai'] as const;
const FALLBACK_WARNING = 'Using plaintext credential fallback storage (permissions 0600 in a 0700 directory); no at-rest encryption is available';

export interface CredentialDiagnostic {
  level: 'info' | 'warn';
  message: string;
}

const emittedCredentialWarnings = new Set<string>();

function reportWarning(diag: ((msg: string) => void) | undefined, message: string): void {
  if (diag) {
    diag(message);
    return;
  }
  if (emittedCredentialWarnings.has(message)) return;
  emittedCredentialWarnings.add(message);
  console.warn(`leverframe: ${message}`);
}

async function keyringOperation(input: KeyringOperation): Promise<KeyringResult> {
  return runIsolatedKeyringOperation(input);
}

export const _credentialStoreInternals = { keyringOperation };

function readKeyringService(service: string, account: string): Promise<KeyringResult> {
  return _credentialStoreInternals.keyringOperation({ operation: 'read', service, account });
}

function isIntegrityError(error: string): boolean {
  return /^integrity:/i.test(error);
}

export async function readStoredCredential(account: string, diag?: (msg: string) => void): Promise<string | null> {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    const primary = await readKeyringService(KEYRING_SERVICE, account);
    if (primary.ok && primary.deleted) return null;
    if (primary.ok && primary.value !== null) return primary.value;
    if (!primary.ok) {
      if (isIntegrityError(primary.error)) {
        reportWarning(diag, `${classifyKeyringError(primary.error)} (account ${account}); run \`leverframe keyring repair\` to rebuild the journal`);
        return null;
      }
      reportWarning(diag, classifyKeyringError(primary.error));
    }

    for (const service of LEGACY_KEYRING_SERVICES) {
      const legacy = await readKeyringService(service, account);
      if (legacy.ok && legacy.value !== null) {
        await writeStoredCredentialUnlocked(account, legacy.value, diag);
        return legacy.value;
      }
      if (!legacy.ok) {
        reportWarning(diag, classifyKeyringError(legacy.error));
        if (isIntegrityError(legacy.error)) return null;
      }
    }

    const fallback = readFallbackCredential(account);
    if (fallback !== null) reportWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
    return fallback;
  });
}

async function writeStoredCredentialUnlocked(account: string, value: string, diag?: (msg: string) => void): Promise<boolean> {
  const result = await _credentialStoreInternals.keyringOperation({ operation: 'write', service: KEYRING_SERVICE, account, value });
  if (result.ok) {
    try {
      deleteFallbackCredential(account);
    } catch (error) {
      reportWarning(diag, `Keyring save succeeded, but stale fallback material was not removed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }
  reportWarning(diag, classifyKeyringError(result.error));
  if (isIntegrityError(result.error)) return false;
  try {
    writeFallbackCredential(account, value);
    reportWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
    return true;
  } catch (error) {
    reportWarning(diag, `Could not write credential fallback: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function writeStoredCredential(account: string, value: string, diag?: (msg: string) => void): Promise<boolean> {
  return withCredentialMutationLock(
    `keyring:${account}`,
    () => writeStoredCredentialUnlocked(account, value, diag),
  );
}

export function deleteStoredCredential(account: string, diag?: (msg: string) => void): Promise<boolean> {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    const result = await _credentialStoreInternals.keyringOperation({ operation: 'delete', service: KEYRING_SERVICE, account });
    if (!result.ok) reportWarning(diag, classifyKeyringError(result.error));
    let fallbackAbsent = false;
    try {
      deleteFallbackCredential(account);
      fallbackAbsent = readFallbackCredential(account) === null;
    } catch (error) {
      reportWarning(diag, `Could not verify credential fallback deletion: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result.ok && fallbackAbsent;
  });
}

/**
 * Repair a corrupted keyring transaction journal for one account. Retains the
 * published credential when it is readable and clears every leverframe entry
 * for the account when it is not, so the user can re-add it cleanly.
 */
export function repairStoredCredential(account: string): Promise<KeyringResult> {
  return withCredentialMutationLock(
    `keyring:${account}`,
    () => _credentialStoreInternals.keyringOperation({ operation: 'repair', service: KEYRING_SERVICE, account }),
  );
}

export async function diagnoseCredentialStorage(env: NodeJS.ProcessEnv = process.env): Promise<CredentialDiagnostic[]> {
  if (process.platform !== 'linux') return [];
  const headless = Boolean(env.SSH_CONNECTION || env.SSH_TTY || (!env.DISPLAY && !env.WAYLAND_DISPLAY));
  const diagnostics: CredentialDiagnostic[] = [];
  if (headless) diagnostics.push({ level: 'info', message: 'Headless/SSH session detected; OpenAI device-code sign-in does not require a GUI.' });
  const dbusReason = missingDbusReason(env);
  const probe = dbusReason
    ? { ok: false as const, error: dbusReason }
    : await runIsolatedKeyringOperation({ operation: 'read', service: KEYRING_SERVICE, account: '__leverframe_probe__' }, { env });
  if (!probe.ok) {
    diagnostics.push({
      level: 'warn',
      message: `${classifyKeyringError(probe.error)}. ${FALLBACK_WARNING}: ${getCredentialFallbackPath(env)}.`,
    });
  }
  return diagnostics;
}
