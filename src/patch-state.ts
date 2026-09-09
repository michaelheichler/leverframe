

import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome, getDefaultAppHome, resolveAppHomeOverride } from './paths.js';
import { ensurePrivateDirectory, readFileStrict } from './durable-io.js';
import { atomicWriteJsonSync, copyImmutableFileSync, removeFileDurableSync } from './atomic-file.js';
import { PATCH_TRANSFORMS_VERSION } from './patch-transforms.js';

export const PATCH_STATE_SCHEMA_VERSION = 2;

export type BaselineProvenance = 'live' | 'backup' | 'legacy-migrated';

export interface PatchManifestV2 {
  schemaVersion: typeof PATCH_STATE_SCHEMA_VERSION;
  transformVersion: number;

  generation: number;
  logicalPath: string;
  canonicalPath: string;
  installationKind: string;
  claudeVersion: string;
  baselineSha256: string;
  baselinePath: string;
  patchedSha256: string;
  patchedSize: number;

  semanticFingerprint: string;
  configHash: string;
  provenance: BaselineProvenance;
  completedAt: string;
}

export function getPatchStateRoot(): string {
  return join(getAppHome(), 'state', 'patches');
}

export function getPatchTargetDir(identity: string): string {
  return join(getPatchStateRoot(), identity);
}

export function getPatchManifestPathV2(identity: string): string {
  return join(getPatchTargetDir(identity), 'manifest.json');
}

export function getPatchTransactionPathV2(identity: string): string {
  return join(getPatchTargetDir(identity), 'transaction.json');
}

export function getPatchLockPathV2(identity: string): string {
  return join(getPatchTargetDir(identity), 'lock');
}

export function getPatchBaselinesDirV2(identity: string): string {
  return join(getPatchTargetDir(identity), 'baselines');
}

export function getBaselineFileName(version: string, baselineSha256: string): string {
  const tag = version.replace(/[^\w.-]+/g, '_');
  const hash = baselineSha256.replace(/[^0-9a-f]/gi, '').slice(0, 64);
  return `claude-${tag}-${hash}.orig`;
}

export function getBaselinePathV2(identity: string, version: string, baselineSha256: string): string {
  return join(getPatchBaselinesDirV2(identity), getBaselineFileName(version, baselineSha256));
}

const MAX_MANIFEST_BYTES = 64 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseManifestV2(raw: unknown): PatchManifestV2 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== PATCH_STATE_SCHEMA_VERSION) return null;
  if (typeof m.transformVersion !== 'number' || typeof m.generation !== 'number') return null;
  if (!isNonEmptyString(m.logicalPath) || !isNonEmptyString(m.canonicalPath)) return null;
  if (!isNonEmptyString(m.installationKind) || !isNonEmptyString(m.claudeVersion)) return null;
  if (!isNonEmptyString(m.baselineSha256) || !isNonEmptyString(m.baselinePath)) return null;
  if (!isNonEmptyString(m.patchedSha256) || typeof m.patchedSize !== 'number') return null;
  if (!isNonEmptyString(m.semanticFingerprint) || !isNonEmptyString(m.configHash)) return null;
  if (m.provenance !== 'live' && m.provenance !== 'backup' && m.provenance !== 'legacy-migrated') return null;
  if (!isNonEmptyString(m.completedAt)) return null;
  return m as unknown as PatchManifestV2;
}

export function readManifestV2(identity: string): PatchManifestV2 | null {
  const path = getPatchManifestPathV2(identity);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileStrict(path, { maxBytes: MAX_MANIFEST_BYTES, description: 'Patch manifest' });
    return parseManifestV2(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readManifestV2File(path: string): PatchManifestV2 | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileStrict(path, { maxBytes: MAX_MANIFEST_BYTES, description: 'Patch manifest' });
    return parseManifestV2(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readManifestV2FromHome(home: string, identity: string): PatchManifestV2 | null {
  return readManifestV2File(join(home, 'state', 'patches', identity, 'manifest.json'));
}

export function defaultHomeOwnsPatchedBinary(
  identity: string,
  liveSha256: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!liveSha256) return false;
  const override = resolveAppHomeOverride(env);
  if (!override) return false;
  const defaultHome = getDefaultAppHome(env);
  if (override === defaultHome) return false;
  return readManifestV2FromHome(defaultHome, identity)?.patchedSha256 === liveSha256;
}

export function writeManifestV2(identity: string, manifest: PatchManifestV2): void {
  ensurePrivateDirectory(getPatchTargetDir(identity));
  atomicWriteJsonSync(getPatchManifestPathV2(identity), manifest);
}

export function removeManifestV2(identity: string): void {
  removeFileDurableSync(getPatchManifestPathV2(identity));
}

export interface StoreBaselineInput {
  identity: string;
  version: string;
  baselineSha256: string;
  sourcePath: string;
}

const BASELINE_FILE_MODE = 0o700;

export function ensureBaselineExecutable(path: string): void {
  try {
    chmodSync(path, BASELINE_FILE_MODE);
  } catch {

  }
}

export function ensureBaselineStored(input: StoreBaselineInput): string {
  const dest = getBaselinePathV2(input.identity, input.version, input.baselineSha256);
  if (existsSync(dest)) {
    ensureBaselineExecutable(dest);
    return dest;
  }
  copyImmutableFileSync(input.sourcePath, dest, { mode: BASELINE_FILE_MODE });
  return dest;
}

export function currentTransformVersion(): number {
  return PATCH_TRANSFORMS_VERSION;
}
