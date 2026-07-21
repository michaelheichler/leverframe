import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import forge from 'node-forge';
import { _caLockInternals, CaLockBusyError, ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { resetLegacyMigrationForTests, getAppHome } from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;

function certDir(): string {
  return join(getAppHome(), 'http-proxy');
}

function readCert(path: string): forge.pki.Certificate {
  return forge.pki.certificateFromPem(readFileSync(path, 'utf8'));
}

interface WorkerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnCaWorker(home: string, syncDir: string, capability: string, workerId: string): {
  child: ChildProcess;
  result: Promise<WorkerResult>;
} {
  const child = spawn(
    process.execPath,
    [join('node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/http-proxy-ca-worker.test.ts'],
    {
      env: {
        ...process.env,
        LEVERFRAME_HOME: home,
        LEVERFRAME_CA_WORKER_MODE: 'run',
        LEVERFRAME_CA_WORKER_HOME: home,
        LEVERFRAME_CA_WORKER_SYNC_DIR: syncDir,
        LEVERFRAME_CA_WORKER_CAPABILITY: capability,
        LEVERFRAME_CA_WORKER_ID: workerId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const result = new Promise<WorkerResult>(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.once('close', exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
    child.once('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
  return { child, result };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  // Invariant: the marker is still absent and the fixed deadline has not passed.
  // Variant: max(0, deadline - Date.now()) decreases after each sleep.
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-ca-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  resetLegacyMigrationForTests();
});

describe('MITM CA rotation policy', () => {
  it('issues a root CA with at most 1 year of validity', () => {
    const before = Date.now();
    const certs = ensureHttpProxyCertificates();
    const after = Date.now();

    const ca = readCert(certs.caCertPath);
    const lifetimeDays = (ca.validity.notAfter.getTime() - ca.validity.notBefore.getTime()) / (24 * 60 * 60 * 1000);
    expect(lifetimeDays).toBeLessThanOrEqual(365);
    expect(ca.validity.notBefore.getTime()).toBeLessThanOrEqual(after);
    expect(ca.validity.notAfter.getTime()).toBeGreaterThanOrEqual(before + 363 * 24 * 60 * 60 * 1000);
  });

  it('never lets the server cert outlive the issuing CA', () => {
    const certs = ensureHttpProxyCertificates();
    const ca = readCert(certs.caCertPath);
    const server = readCert(join(certDir(), 'api.anthropic.com.pem'));
    expect(server.validity.notAfter.getTime()).toBeLessThanOrEqual(ca.validity.notAfter.getTime());
  });

  it('issues a server cert with at most 1 year of validity anchored to notBefore', () => {
    const certs = ensureHttpProxyCertificates();
    const server = readCert(join(certDir(), 'api.anthropic.com.pem'));
    const lifetimeDays = (server.validity.notAfter.getTime() - server.validity.notBefore.getTime()) / (24 * 60 * 60 * 1000);
    expect(lifetimeDays).toBeLessThanOrEqual(365);
  });

  it('rotates an existing 10-year CA on the next startup', () => {
    const certs = ensureHttpProxyCertificates();
    const caPath = certs.caCertPath;
    const firstCa = readCert(caPath);
    expect(firstCa.validity.notAfter.getTime() - firstCa.validity.notBefore.getTime())
      .toBeLessThanOrEqual(366 * 24 * 60 * 60 * 1000);

    // Simulate a legacy v1 10-year CA on disk: version=1 + 10-year cert.
    const dir = certDir();
    const caKey = forge.pki.rsa.generateKeyPair(2048);
    const legacyCa = forge.pki.createCertificate();
    legacyCa.publicKey = caKey.publicKey;
    legacyCa.serialNumber = 'ab';
    legacyCa.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    legacyCa.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    legacyCa.setSubject([{ name: 'commonName', value: 'leverframe local HTTP proxy CA' }]);
    legacyCa.setIssuer([{ name: 'commonName', value: 'leverframe local HTTP proxy CA' }]);
    legacyCa.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    ]);
    legacyCa.sign(caKey.privateKey, forge.md.sha256.create());

    writeFileSync(join(dir, 'leverframe-ca.pem'), forge.pki.certificateToPem(legacyCa), { mode: 0o644 });
    writeFileSync(join(dir, 'leverframe-ca-key.pem'), forge.pki.privateKeyToPem(caKey.privateKey), { mode: 0o600 });
    writeFileSync(join(dir, 'version'), '1\n', { mode: 0o644 });

    const rotated = ensureHttpProxyCertificates();
    const rotatedCa = readCert(rotated.caCertPath);
    const rotatedLifetimeDays = (rotatedCa.validity.notAfter.getTime() - rotatedCa.validity.notBefore.getTime())
      / (24 * 60 * 60 * 1000);
    expect(rotatedLifetimeDays).toBeLessThanOrEqual(365);
    expect(readFileSync(join(dir, 'version'), 'utf8')).toBe('2\n');
  });

  it('writes CA key and server key with 0600 and the directory with 0700', () => {
    const certs = ensureHttpProxyCertificates();
    const dir = certDir();
    const dirMode = statSync(dir).mode & 0o777;
    const caKeyMode = statSync(join(dir, 'leverframe-ca-key.pem')).mode & 0o777;
    const serverKeyMode = statSync(join(dir, 'api.anthropic.com-key.pem')).mode & 0o777;
    const caCertMode = statSync(certs.caCertPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(caKeyMode).toBe(0o600);
    expect(serverKeyMode).toBe(0o600);
    expect(caCertMode).toBe(0o644);
  });

  it('rotates when stored cert files are missing even if version matches', () => {
    const certs = ensureHttpProxyCertificates();
    const dir = certDir();
    rmSync(join(dir, 'api.anthropic.com.pem'), { force: true });
    const regenerated = ensureHttpProxyCertificates();
    expect(existsSync(join(dir, 'api.anthropic.com.pem'))).toBe(true);
    expect(regenerated.serverCert).toContain('BEGIN CERTIFICATE');
  });

  it('reuses the existing CA across calls when it is still current', () => {
    const first = ensureHttpProxyCertificates();
    const firstCa = readFileSync(first.caCertPath, 'utf8');
    const second = ensureHttpProxyCertificates();
    const secondCa = readFileSync(second.caCertPath, 'utf8');
    expect(secondCa).toBe(firstCa);
  });

  it('rotates when a private key is missing even though both certificates are current', () => {
    const first = ensureHttpProxyCertificates();
    rmSync(join(certDir(), 'api.anthropic.com-key.pem'));

    const repaired = ensureHttpProxyCertificates();
    expect(repaired.caCert).not.toBe(first.caCert);
    expect(existsSync(join(certDir(), 'api.anthropic.com-key.pem'))).toBe(true);
  });
});

describe('MITM CA generation lock', () => {
  it('never removes malformed, dead-pid, or replaced foreign locks', () => {
    const lockPath = _caLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'not-json', { mode: 0o600 });
    expect(_caLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(readFileSync(lockPath, 'utf8')).toBe('not-json');

    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, startedAt: 0, nonce: 'foreign-dead' }));
    expect(_caLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe('foreign-dead');

    rmSync(lockPath);
    const release = _caLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: 'replacement' }));
    release!();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe('replacement');
  });

  it('times out after a bounded wait with the lock path and recovery action', () => {
    const lockPath = _caLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: 'live' }));
    let monotonic = 0;

    expect(() => _caLockInternals.acquire(lockPath, {
      waitMs: 100,
      retryMs: 25,
      monotonicNow: () => monotonic,
      sleep: ms => { monotonic += ms; },
    })).toThrow(CaLockBusyError);
    try {
      _caLockInternals.acquire(lockPath, { waitMs: 0 });
    } catch (err) {
      expect((err as Error).message).toContain(lockPath);
      expect((err as Error).message).toContain('remove the lock file and re-run');
    }
    expect(existsSync(lockPath)).toBe(true);
  });

  it('serializes deterministic cross-process contention and leaves one verified final certificate set', async () => {
    const home = process.env['LEVERFRAME_HOME']!;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const capability = randomUUID();
    writeFileSync(join(home, '.ca-worker-capability'), capability, { mode: 0o600 });
    const syncDir = mkdtempSync(join(tmpdir(), 'leverframe-ca-sync-'));
    const lockPath = _caLockInternals.lockPath();
    const release = _caLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    const workers = ['a', 'b'].map(id => spawnCaWorker(home, syncDir, capability, id));
    let released = false;

    try {
      for (const id of ['a', 'b']) await waitForFile(join(syncDir, `${id}.ready`));
      writeFileSync(join(syncDir, 'start'), '', { mode: 0o600 });
      for (const id of ['a', 'b']) await waitForFile(join(syncDir, `${id}.attempt`));
      release!();
      released = true;

      const parentSet = ensureHttpProxyCertificates();
      const results = await Promise.all(workers.map(worker => worker.result));
      for (const result of results) {
        expect(result.timedOut, result.stderr).toBe(false);
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      }

      const finalCa = forge.pki.certificateFromPem(parentSet.caCert);
      const finalServer = forge.pki.certificateFromPem(parentSet.serverCert);
      expect(finalCa.verify(finalServer)).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (!released) release!();
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      }
      await Promise.allSettled(workers.map(worker => worker.result));
      rmSync(syncDir, { recursive: true, force: true });
    }
  }, 120_000);
});
