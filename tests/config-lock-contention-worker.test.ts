import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPreferences, setAppPathOverride } from '../src/config.js';

const WORKER_MODE = process.env.LEVERFRAME_LOCK_WORKER_MODE;
const WORKER_ID = process.env.LEVERFRAME_LOCK_WORKER_ID ?? '0';
const WORKER_ROUNDS = Number(process.env.LEVERFRAME_LOCK_WORKER_ROUNDS ?? '8');
const WORKER_HOME = process.env.LEVERFRAME_LOCK_WORKER_HOME;
const WORKER_CAPABILITY = process.env.LEVERFRAME_LOCK_WORKER_CAPABILITY;
const WORKER_SYNC_DIR = process.env.LEVERFRAME_LOCK_WORKER_SYNC_DIR;
const START_WAIT_MS = Number(process.env.LEVERFRAME_LOCK_WORKER_START_WAIT_MS ?? '15000');
const MARKER_POLL_MS = 25;

const CAPABILITY_MARKER_NAME = '.lock-worker-capability';

function readCapabilityMarker(home: string): string | null {
  try {
    return readFileSync(join(home, CAPABILITY_MARKER_NAME), 'utf8').trim();
  } catch {
    return null;
  }
}

function shouldRunWorkerFixture(): boolean {
  if (WORKER_MODE !== 'run') return false;
  if (!WORKER_HOME || !WORKER_CAPABILITY || !WORKER_SYNC_DIR) return false;
  if (process.env.LEVERFRAME_HOME !== WORKER_HOME) return false;
  const marker = readCapabilityMarker(WORKER_HOME);
  if (marker === null || marker !== WORKER_CAPABILITY) return false;
  return true;
}

async function waitForStartMarker(startMarker: string): Promise<void> {
  const deadline = Date.now() + START_WAIT_MS;
  while (!existsSync(startMarker)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `lock worker ${WORKER_ID} timed out after ${START_WAIT_MS}ms waiting for START marker at ${startMarker}`,
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, MARKER_POLL_MS));
  }
}

describe.runIf(shouldRunWorkerFixture())('production config lock worker', () => {
  it('concurrent setAppPathOverride preserves every worker key through the production lock', async () => {
    if (
      WORKER_MODE !== 'run'
      || !WORKER_HOME
      || !WORKER_CAPABILITY
      || !WORKER_SYNC_DIR
      || process.env.LEVERFRAME_HOME !== WORKER_HOME
    ) {
      return;
    }

    const readyMarker = join(WORKER_SYNC_DIR, `${WORKER_ID}.ready`);
    const attemptMarker = join(WORKER_SYNC_DIR, `${WORKER_ID}.attempt`);
    const startMarker = join(WORKER_SYNC_DIR, 'start.marker');

    mkdirSync(WORKER_SYNC_DIR, { recursive: true });
    writeFileSync(readyMarker, '', { mode: 0o600 });

    await waitForStartMarker(startMarker);

    writeFileSync(attemptMarker, '', { mode: 0o600 });

    const workerKey = `worker-${WORKER_ID}`;
    for (let i = 0; i < WORKER_ROUNDS; i++) {
      setAppPathOverride(workerKey, `value-${i}`);
    }

    const final = loadPreferences();
    expect(final.appPathOverrides?.[workerKey]).toBe(`value-${WORKER_ROUNDS - 1}`);
  }, 60_000);
});
