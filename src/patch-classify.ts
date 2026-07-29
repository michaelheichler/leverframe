// src/patch-classify.ts — pure patch-state classification (no I/O).
//
// Deliberately separated from src/patch-state.ts, which only owns the V2
// manifest schema and its on-disk persistence. This module owns the business
// rule from docs/stabilization-and-upstream-plan.md section 5.3: turning a
// live inspection plus an optional manifest into one of the nine explicit
// patch states. Kept dependency-free (besides the manifest type and the
// current transform version) so patch-reconcile.ts and patch-diagnostics.ts
// can both call it without importing each other.

import { currentTransformVersion, type PatchManifestV2 } from './patch-state.js';

/** docs/stabilization-and-upstream-plan.md section 5.3. */
export type PatchStateV2 =
  | 'unpatched'
  | 'patched'
  | 'config_stale'
  | 'updated'
  | 'modified'
  | 'modified_but_injected'
  | 'partially_patched'
  | 'state_missing'
  | 'unsupported';

export interface EvaluateStateInput {
  installationVersion: string;
  manifest: PatchManifestV2 | null;
  live: {
    readable: boolean;
    version: string | null;
    sha256: string | null;
    injectionState: 'present' | 'absent' | 'ambiguous';
  };
  desiredConfigHash: string;
  /** Whether the required patch sites still verify OK against the live content, when hashes disagree. */
  semanticSitesComplete?: boolean;
}

/**
 * Classify a target's current patch state from live inspection plus (if any)
 * its V2 manifest. A marker-bearing target is never reported as plain
 * `unpatched` (docs section 5.3) — the classic false-warning loop this
 * replaces came from collapsing "injected with no state" into "unpatched".
 */
export function evaluatePatchStateV2(input: EvaluateStateInput): PatchStateV2 {
  const { installationVersion, manifest, live, desiredConfigHash, semanticSitesComplete } = input;
  if (!live.readable || !live.version) return 'unsupported';
  if (live.injectionState === 'ambiguous') return 'unsupported';

  if (live.injectionState === 'absent') {
    if (!manifest) return 'unpatched';
    // A refreshed, unmarked live binary is authoritative (docs section 4.1 /
    // b5bc3c5): never treat it as a damaged patch just because stale state exists.
    if (live.sha256 === manifest.baselineSha256) return 'unpatched';
    return 'modified';
  }

  // injectionState === 'present'
  if (!manifest) return 'state_missing';
  if (manifest.claudeVersion !== installationVersion) return 'updated';
  if (manifest.patchedSha256 !== live.sha256) {
    return semanticSitesComplete === true ? 'modified_but_injected' : 'partially_patched';
  }
  if (manifest.configHash !== desiredConfigHash || manifest.transformVersion !== currentTransformVersion()) {
    return 'config_stale';
  }
  return 'patched';
}

/** Exact-byte matches and verified post-publication rewrites are both current. */
export function isCurrentPatchState(state: PatchStateV2 | null): boolean {
  return state === 'patched' || state === 'modified_but_injected';
}

export function describePatchStateV2(state: PatchStateV2 | null): string {
  switch (state) {
    case 'unpatched': return 'not patched';
    case 'state_missing': return 'injected but missing Leverframe state';
    case 'updated': return 'stale-patched (claude was updated)';
    case 'modified': return 'externally modified';
    case 'modified_but_injected': return 'externally modified but still Leverframe-patched';
    case 'partially_patched': return 'only partially patched';
    case 'config_stale': return 'stale-patched (config changed)';
    case 'unsupported': return 'in an unrecognized state';
    case 'patched': return 'patched';
    default: return 'in an unknown state';
  }
}
