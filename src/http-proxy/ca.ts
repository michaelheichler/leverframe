import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import forge from 'node-forge';
import { getAppHome } from '../paths.js';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export interface HttpProxyCertificates {
  caCertPath: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
}

const CERT_DIR = 'http-proxy';
const CA_CERT_FILE = 'leverframe-ca.pem';
const CA_KEY_FILE = 'leverframe-ca-key.pem';
const SERVER_CERT_FILE = 'api.anthropic.com.pem';
const SERVER_KEY_FILE = 'api.anthropic.com-key.pem';
const CERT_VERSION_FILE = 'version';
const CERT_SET_FILE = 'set-id';

// v2 rotates away every v1 CA (including the legacy 10-year ones).
const CERT_VERSION = '2\n';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CA_LIFETIME_MS = 365 * MS_PER_DAY;
const SERVER_LIFETIME_MS = 365 * MS_PER_DAY;
const CLOCK_SKEW_BACKSTART_MS = MS_PER_DAY;
const RENEWAL_BUFFER_MS = 7 * MS_PER_DAY;

const CA_LOCK_WAIT_MS = 30_000;
const CA_LOCK_RETRY_MS = 50;
const CA_LOCK_BUSY_ERROR = 'CaLockBusyError';

function serialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

interface CaLockContent {
  pid: number;
  startedAt: number;
  nonce: string;
}

function caLockPath(): string {
  return join(getAppHome(), CERT_DIR, 'ca-generation.lock');
}

export class CaLockBusyError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, waitedMs: number) {
    super(
      `Could not acquire the CA generation lock at ${lockPath} after ${waitedMs}ms. `
        + 'Another leverframe process is generating the MITM CA. '
        + 'If no leverframe process is running, remove the lock file and re-run.',
    );
    this.name = CA_LOCK_BUSY_ERROR;
    this.lockPath = lockPath;
  }
}

function isRegularLockPath(lockPath: string): boolean {
  try {
    return lstatSync(lockPath).isFile();
  } catch {
    return true;
  }
}

function readLockMetadata(lockPath: string): CaLockContent | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Partial<CaLockContent>;
  if (typeof obj.pid !== 'number' || !Number.isFinite(obj.pid)) return null;
  if (typeof obj.startedAt !== 'number' || !Number.isFinite(obj.startedAt)) return null;
  if (typeof obj.nonce !== 'string' || obj.nonce.length === 0) return null;
  return { pid: obj.pid, startedAt: obj.startedAt, nonce: obj.nonce };
}

function unlinkLockIfOwned(lockPath: string, nonce: string): void {
  const current = readLockMetadata(lockPath);
  if (current === null || current.nonce !== nonce) return;
  try { unlinkSync(lockPath); } catch { /* already gone or not owned */ }
}

function releaseCaLock(lockPath: string, nonce: string): void {
  const tombstone = `${lockPath}.release-${nonce}`;
  try {
    renameSync(lockPath, tombstone);
  } catch {
    return;
  }

  const current = readLockMetadata(tombstone);
  if (current?.nonce === nonce) {
    try { unlinkSync(tombstone); } catch { /* already gone */ }
    return;
  }

  // Hard-link restoration is create-only: it cannot replace a successor that
  // acquired the canonical path while this foreign lock was quarantined.
  try {
    linkSync(tombstone, lockPath);
    unlinkSync(tombstone);
  } catch { /* preserve foreign tombstone */ }
}

function tryAcquireCaLock(
  lockPath: string,
  opts: { now?: number } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const nonce = randomUUID();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  if (!isRegularLockPath(lockPath)) return null;

  let fd: number | undefined;
  try {
    fd = openSync(
      lockPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST' || code === 'ELOOP') return null;
    throw err;
  }

  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, nonce } satisfies CaLockContent));
    closeSync(fd);
    fd = undefined;
  } catch (publishErr) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* fd may already be closed */ }
    }
    // A partial file has no provable owner. Leave it for explicit recovery
    // rather than risk deleting a lock another process replaced.
    unlinkLockIfOwned(lockPath, nonce);
    throw publishErr;
  }

  return () => releaseCaLock(lockPath, nonce);
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin until deadline */ }
  }
}

function acquireCaLockSync(
  lockPath = caLockPath(),
  opts: {
    waitMs?: number;
    retryMs?: number;
    monotonicNow?: () => number;
    sleep?: (ms: number) => void;
  } = {},
): () => void {
  const waitMs = opts.waitMs ?? CA_LOCK_WAIT_MS;
  const retryMs = opts.retryMs ?? CA_LOCK_RETRY_MS;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const sleep = opts.sleep ?? sleepSync;
  const deadline = monotonicNow() + waitMs;
  // Invariant: no existing lock is removed; success means this caller exclusively created the lock.
  // Variant: max(0, deadline - monotonicNow()) decreases after each bounded sleep.
  for (;;) {
    const release = tryAcquireCaLock(lockPath);
    if (release) return release;
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) throw new CaLockBusyError(lockPath, waitMs);
    sleep(Math.min(retryMs, remaining));
  }
}

/** @internal Exported for deterministic lock-behavior tests. */
export const _caLockInternals = {
  lockPath: caLockPath,
  tryAcquire: tryAcquireCaLock,
  acquire: acquireCaLockSync,
  release: releaseCaLock,
  waitMs: CA_LOCK_WAIT_MS,
  isRegularFile: isRegularLockPath,
  buildContent: (nonce: string, now: number): CaLockContent => ({ pid: process.pid, startedAt: now, nonce }),
};

function certPaths(): Record<'dir' | 'caCert' | 'caKey' | 'serverCert' | 'serverKey' | 'version' | 'setId', string> {
  const dir = join(getAppHome(), CERT_DIR);
  return {
    dir,
    caCert: join(dir, CA_CERT_FILE),
    caKey: join(dir, CA_KEY_FILE),
    serverCert: join(dir, SERVER_CERT_FILE),
    serverKey: join(dir, SERVER_KEY_FILE),
    version: join(dir, CERT_VERSION_FILE),
    setId: join(dir, CERT_SET_FILE),
  };
}

function writePrivate(path: string, value: string): void {
  atomicWrite(path, value, 0o600);
}

function writePublic(path: string, value: string): void {
  atomicWrite(path, value, 0o644);
}

function atomicWrite(path: string, value: string, mode: 0o600 | 0o644): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', mode, flag: 'wx' });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function generateCertificates(paths: ReturnType<typeof certPaths>): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);

  const now = Date.now();
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = serialNumber();
  caCert.validity.notBefore = new Date(now - CLOCK_SKEW_BACKSTART_MS);
  caCert.validity.notAfter = new Date(caCert.validity.notBefore.getTime() + CA_LIFETIME_MS);
  const caAttrs = [{ name: 'commonName', value: 'leverframe local HTTP proxy CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const serverKeys = forge.pki.rsa.generateKeyPair(2048);
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = serialNumber();
  serverCert.validity.notBefore = new Date(now - CLOCK_SKEW_BACKSTART_MS);
  const serverNotAfter = Math.min(
    serverCert.validity.notBefore.getTime() + SERVER_LIFETIME_MS,
    caCert.validity.notAfter.getTime(),
  );
  serverCert.validity.notAfter = new Date(serverNotAfter);
  serverCert.setSubject([{ name: 'commonName', value: 'api.anthropic.com' }]);
  serverCert.setIssuer(caCert.subject.attributes);
  serverCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'api.anthropic.com' }] },
    { name: 'subjectKeyIdentifier' },
  ]);
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create());

  writePrivate(paths.caKey, forge.pki.privateKeyToPem(caKeys.privateKey));
  writePublic(paths.caCert, forge.pki.certificateToPem(caCert));
  writePrivate(paths.serverKey, forge.pki.privateKeyToPem(serverKeys.privateKey));
  writePublic(paths.serverCert, forge.pki.certificateToPem(serverCert));
  writePublic(paths.version, CERT_VERSION);
  // Commit marker written last. Readers accept only a complete, self-consistent set.
  writePublic(paths.setId, `${randomUUID()}\n`);
}

function publicKeyMatchesPrivateKey(certificate: forge.pki.Certificate, privateKey: forge.pki.PrivateKey): boolean {
  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;
  const rsaPrivateKey = privateKey as forge.pki.rsa.PrivateKey;
  return publicKey.n.compareTo(rsaPrivateKey.n) === 0 && publicKey.e.compareTo(rsaPrivateKey.e) === 0;
}

function readCurrentCertificateSet(paths: ReturnType<typeof certPaths>): HttpProxyCertificates | null {
  try {
    const setIdBefore = readFileSync(paths.setId, 'utf8');
    if (!setIdBefore.trim()) return null;
    if (readFileSync(paths.version, 'utf8') !== CERT_VERSION) return null;
    const caCert = readFileSync(paths.caCert, 'utf8');
    const caKey = readFileSync(paths.caKey, 'utf8');
    const serverCert = readFileSync(paths.serverCert, 'utf8');
    const serverKey = readFileSync(paths.serverKey, 'utf8');
    const ca = forge.pki.certificateFromPem(caCert);
    const caPrivateKey = forge.pki.privateKeyFromPem(caKey);
    const server = forge.pki.certificateFromPem(serverCert);
    const serverPrivateKey = forge.pki.privateKeyFromPem(serverKey);
    const now = Date.now();
    const valid = ca.validity.notBefore.getTime() <= now
      && ca.validity.notAfter.getTime() > now + RENEWAL_BUFFER_MS
      && server.validity.notBefore.getTime() <= now
      && server.validity.notAfter.getTime() > now + RENEWAL_BUFFER_MS
      && ca.verify(ca)
      && ca.verify(server)
      && publicKeyMatchesPrivateKey(ca, caPrivateKey)
      && publicKeyMatchesPrivateKey(server, serverPrivateKey);
    if (!valid || readFileSync(paths.setId, 'utf8') !== setIdBefore) return null;
    return { caCertPath: paths.caCert, caCert, serverCert, serverKey };
  } catch {
    return null;
  }
}

/** Create the local CA once, then reuse it so active sessions keep trusting the proxy. */
export function ensureHttpProxyCertificates(): HttpProxyCertificates {
  const paths = certPaths();
  const current = readCurrentCertificateSet(paths);
  if (current) return current;

  const release = acquireCaLockSync();
  try {
    const afterAcquire = readCurrentCertificateSet(paths);
    if (afterAcquire) return afterAcquire;
    generateCertificates(paths);
    const generated = readCurrentCertificateSet(paths);
    if (!generated) throw new Error(`Generated MITM certificate set at ${paths.dir} failed integrity verification`);
    return generated;
  } finally {
    release();
  }
}

/** Preserve an existing corporate/custom Node CA bundle alongside Relay's CA. */
export function ensureHttpProxyCaBundle(
  relayCaCertPath: string,
  additionalCaCertPath: string | undefined,
): string {
  if (!additionalCaCertPath?.trim()) return relayCaCertPath;
  try {
    if (resolve(additionalCaCertPath) === resolve(relayCaCertPath)) return relayCaCertPath;
    const relayCa = readFileSync(relayCaCertPath, 'utf8').trimEnd();
    const additionalCa = readFileSync(additionalCaCertPath, 'utf8').trim();
    if (!additionalCa) return relayCaCertPath;
    const combinedPath = join(dirname(relayCaCertPath), 'combined-ca.pem');
    writePublic(combinedPath, `${relayCa}\n${additionalCa}\n`);
    return combinedPath;
  } catch {
    return relayCaCertPath;
  }
}
