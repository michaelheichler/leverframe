import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';

const mode = process.env['LEVERFRAME_CA_WORKER_MODE'];
const home = process.env['LEVERFRAME_CA_WORKER_HOME'];
const syncDir = process.env['LEVERFRAME_CA_WORKER_SYNC_DIR'];
const capability = process.env['LEVERFRAME_CA_WORKER_CAPABILITY'];
const workerId = process.env['LEVERFRAME_CA_WORKER_ID'];

function enabled(): boolean {
  if (mode !== 'run' || !home || !syncDir || !capability || !workerId) return false;
  if (process.env['LEVERFRAME_HOME'] !== home) return false;
  try {
    return readFileSync(join(home, '.ca-worker-capability'), 'utf8') === capability;
  } catch {
    return false;
  }
}

async function waitForStart(): Promise<void> {
  const deadline = Date.now() + 15_000;
  // Invariant: start is absent and the worker has not passed its deadline.
  // Variant: max(0, deadline - Date.now()) decreases after each sleep.
  while (!existsSync(join(syncDir!, 'start'))) {
    if (Date.now() >= deadline) throw new Error('CA worker timed out waiting for start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.runIf(enabled())('CA contention worker', () => {
  it('returns a server certificate verified by the returned CA', async () => {
    writeFileSync(join(syncDir!, `${workerId}.ready`), '', { mode: 0o600 });
    await waitForStart();
    writeFileSync(join(syncDir!, `${workerId}.attempt`), '', { mode: 0o600 });
    const set = ensureHttpProxyCertificates();
    const ca = forge.pki.certificateFromPem(set.caCert);
    const server = forge.pki.certificateFromPem(set.serverCert);
    expect(ca.verify(server)).toBe(true);
  }, 45_000);
});
