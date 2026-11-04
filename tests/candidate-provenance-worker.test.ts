import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeCandidateTestEnvironment } from './fixtures/test-home-lifecycle.js';
import type { CandidateProvenanceRecord } from '../src/test-only/candidate-loopback-transport.js';

const candidate = safeCandidateTestEnvironment(process.env);
const markerPath = candidate ? join(candidate.configRoot, '.candidate-provenance-worker.json') : null;
const workerEnabled = markerPath !== null && (() => {
  try {
    const marker = lstatSync(markerPath);
    const currentUid = process.getuid?.();
    return marker.isFile()
      && (currentUid === undefined || marker.uid === currentUid)
      && realpathSync.native(markerPath) === markerPath;
  } catch {
    return false;
  }
})();

describe.runIf(workerEnabled)('candidate provenance worker', () => {
  it('writes one provenance record under the validated candidate root', async () => {
    const { createCandidateProvenanceHook } = await import('../src/test-only/candidate-loopback-transport.js');
    const record = JSON.parse(readFileSync(markerPath!, 'utf8')) as CandidateProvenanceRecord;
    delete record.ordinal;
    const hook = createCandidateProvenanceHook(join(candidate!.configRoot, 'provenance.jsonl'));

    await expect(hook.beforeTransport(record)).resolves.toBeTypeOf('number');
  });
});
