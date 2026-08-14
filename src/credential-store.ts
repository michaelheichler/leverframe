import { withCredentialMutationLock } from './registry/lock.js';
import {
  buildKeyringHelperEnv,
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

function fallbackWarning(): string {
  return `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`;
}

function removeFallbackCredential(account: string, diag: ((msg: string) => void) | undefined): boolean {
  try {
    deleteFallbackCredential(account);
    if (readFallbackCredential(account) !== null) {
      reportWarning(diag, 'Credential fallback deletion could not be verified');
      return false;
    }
    return true;
  } catch (error) {
    reportWarning(diag, `Could not verify credential fallback deletion: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function promoteFallbackCredential(
  account: string,
  value: string,
  diag: ((msg: string) => void) | undefined,
): Promise<string | null> {
  const published = await _credentialStoreInternals.keyringOperation({
    operation: 'write', service: KEYRING_SERVICE, account, value,
  });
  if (!published.ok) {
    reportWarning(diag, classifyKeyringError(published.error));
    if (isIntegrityError(published.error)) return null;
    reportWarning(diag, fallbackWarning());
    return value;
  }
  const verified = await readKeyringService(KEYRING_SERVICE, account);
  if (!verified.ok) {
    reportWarning(diag, classifyKeyringError(verified.error));
    if (isIntegrityError(verified.error)) return null;
    reportWarning(diag, fallbackWarning());
    return value;
  }
  if (verified.deleted || verified.value !== value) {
    reportWarning(diag, 'Keyring promotion could not be verified');
    return null;
  }
  if (!removeFallbackCredential(account, diag)) return null;
  return value;
}

async function readKeyringAfterIntegrityRepair(opts: {
  account: string;
  primary: KeyringResult;
  diag?: (msg: string) => void;
}): Promise<{ primary: KeyringResult; repaired: boolean }> {
  const { account, primary, diag } = opts;
  if (primary.ok || !isIntegrityError(primary.error)) return { primary, repaired: false };
  reportWarning(diag, `${classifyKeyringError(primary.error)} (account ${account}); repairing keyring journal`);
  const repaired = await _credentialStoreInternals.keyringOperation({
    operation: 'repair',
    service: KEYRING_SERVICE,
    account,
  });
  if (!repaired.ok) {
    reportWarning(diag, classifyKeyringError(repaired.error));
    return { primary, repaired: false };
  }
  if (repaired.value !== null) return { primary: { ok: true, value: repaired.value }, repaired: true };
  return { primary: await readKeyringService(KEYRING_SERVICE, account), repaired: true };
}

export async function readStoredCredential(account: string, diag?: (msg: string) => void): Promise<string | null> {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    const { primary, repaired } = await readKeyringAfterIntegrityRepair({
      account,
      primary: await readKeyringService(KEYRING_SERVICE, account),
      diag,
    });
    if (!primary.ok) {
      if (isIntegrityError(primary.error)) {
        reportWarning(diag, `${classifyKeyringError(primary.error)} (account ${account}); run \`leverframe keyring repair\` to rebuild the journal`);
        return null;
      }
      reportWarning(diag, classifyKeyringError(primary.error));
    }
    if (repaired && primary.ok && primary.value !== null) return primary.value;

    let fallback: string | null;
    try {
      fallback = readFallbackCredential(account);
    } catch (error) {
      reportWarning(diag, `Could not read credential fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (fallback !== null) return promoteFallbackCredential(account, fallback, diag);
    if (primary.ok && primary.deleted) return null;
    if (primary.ok && primary.value !== null) return primary.value;

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

    return null;
  });
}

async function writeStoredCredentialUnlocked(account: string, value: string, diag?: (msg: string) => void): Promise<boolean> {
  let staged = false;
  try {
    staged = readFallbackCredential(account) !== null;
    if (staged) writeFallbackCredential(account, value);
  } catch (error) {
    reportWarning(diag, `Could not update credential fallback: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const result = await _credentialStoreInternals.keyringOperation({ operation: 'write', service: KEYRING_SERVICE, account, value });
  if (result.ok) {
    if (!removeFallbackCredential(account, diag)) {
      reportWarning(diag, 'Keyring save succeeded, but stale fallback material remains queued for removal');
    }
    return true;
  }
  reportWarning(diag, classifyKeyringError(result.error));
  if (isIntegrityError(result.error)) return false;
  try {
    if (!staged) writeFallbackCredential(account, value);
    reportWarning(diag, fallbackWarning());
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
    if (!removeFallbackCredential(account, diag)) return false;
    const result = await _credentialStoreInternals.keyringOperation({ operation: 'delete', service: KEYRING_SERVICE, account });
    if (!result.ok) reportWarning(diag, classifyKeyringError(result.error));
    return result.ok;
  });
}

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
  const helperEnv = buildKeyringHelperEnv(env);
  const dbusReason = missingDbusReason(helperEnv);
  const probe = dbusReason
    ? { ok: false as const, error: dbusReason }
    : await runIsolatedKeyringOperation({ operation: 'read', service: KEYRING_SERVICE, account: '__leverframe_probe__' }, { env: helperEnv });
  if (!probe.ok) {
    diagnostics.push({
      level: 'warn',
      message: `${classifyKeyringError(probe.error)}. ${FALLBACK_WARNING}: ${getCredentialFallbackPath(env)}.`,
    });
  }
  return diagnostics;
}
