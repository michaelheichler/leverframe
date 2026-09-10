import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, type Stats } from 'node:fs';

export function assertPatchFileHash(path: string, expected: string): void {
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) {
    throw new Error(`File hash changed after verification: ${path}`);
  }
}

export function validatePatchPublication(input: {
  target: string;
  targetIdentity: Pick<Stats, 'dev' | 'ino'>;
  expectedPreHash: string;
  stage: string;
  expectedPostHash: string;
  baseline: string;
  baselineSha256: string;
}): void {
  assertPatchFileHash(input.baseline, input.baselineSha256);
  assertPatchFileHash(input.stage, input.expectedPostHash);
  const current = lstatSync(input.target);
  if (!current.isFile() || current.dev !== input.targetIdentity.dev || current.ino !== input.targetIdentity.ino) {
    throw new Error('The live claude destination identity changed during staging.');
  }
  assertPatchFileHash(input.target, input.expectedPreHash);
}
