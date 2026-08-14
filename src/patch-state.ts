// src/patch-state.ts — per-target Claude Code patch state (V2).
//
// Replaces the single global `patch-state.json` with state keyed by canonical
// target identity (docs/stabilization-and-upstream-plan.md section 5.2), so
// two same-version installations on one machine can never share ownership of
// each other's manifest or pristine baseline. Baselines are stored
// content-addressed and immutable: `claude-<version>-<baselineSha256>.orig`.

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome, getDefaultAppHome, resolveAppHomeOverride } from './paths.js';
import { ensurePrivateDirectory, readFileStrict } from './durable-io.js';
import { atomicWriteJsonSync, copyImmutableFileSync } from './atomic-file.js';
import { PATCH_TRANSFORMS_VERSION } from './patch-transforms.js';

export const PATCH_STATE_SCHEMA_VERSION = 2;

export type BaselineProvenance = 'live' | 'backup' | 'legacy-migrated';

export interface PatchManifestV2 {
  schemaVersion: typeof PATCH_STATE_SCHEMA_VERSION;
  transformVersion: number;
  /** Monotonic per-target counter; incremented on every completed transaction. */
  generation: number;
  logicalPath: string;
  canonicalPath: string;
  installationKind: string;
  claudeVersion: string;
  baselineSha256: string;
  baselinePath: string;
  patchedSha256: string;
  patchedSize: number;
  /** Hash of the ordered required-patch-site names that verified OK. */
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

/** Read a target's V2 manifest. Returns null (never throws) if missing, corrupt, or unsupported. */
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

/** Read a V2 manifest from an explicit Leverframe home (not the current LEVERFRAME_HOME). */
export function readManifestV2FromHome(home: string, identity: string): PatchManifestV2 | null {
  return readManifestV2File(join(home, 'state', 'patches', identity, 'manifest.json'));
}

/**
 * True when LEVERFRAME_HOME is an override that has no V2 state, but the
 * default ~/.leverframe already recorded this live binary as a completed V2
 * patch. Launch must not report "injected claude has no V2 patch state".
 */
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

/** Publish a target's V2 manifest atomically and durably. */
export function writeManifestV2(identity: string, manifest: PatchManifestV2): void {
  ensurePrivateDirectory(getPatchTargetDir(identity));
  atomicWriteJsonSync(getPatchManifestPathV2(identity), manifest);
}

export function removeManifestV2(identity: string): void {
  try {
    unlinkSync(getPatchManifestPathV2(identity));
  } catch {
  }
}

export interface StoreBaselineInput {
  identity: string;
  version: string;
  baselineSha256: string;
  sourcePath: string;
}

/**
 * Publish `sourcePath` into the target's content-addressed, immutable baseline
 * store. A no-op if a baseline already exists at that content-addressed path
 * (the name is derived from its own hash, so an existing file is guaranteed
 * identical content). Returns the stored baseline's absolute path.
 */
export function ensureBaselineStored(input: StoreBaselineInput): string {
  const dest = getBaselinePathV2(input.identity, input.version, input.baselineSha256);
  if (existsSync(dest)) return dest;
  copyImmutableFileSync(input.sourcePath, dest, { mode: 0o600 });
  return dest;
}

export function currentTransformVersion(): number {
  return PATCH_TRANSFORMS_VERSION;
}
