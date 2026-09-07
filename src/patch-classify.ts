

import { currentTransformVersion, type PatchManifestV2 } from './patch-state.js';

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

  semanticSitesComplete?: boolean;
}

export function evaluatePatchStateV2(input: EvaluateStateInput): PatchStateV2 {
  const { installationVersion, manifest, live, desiredConfigHash, semanticSitesComplete } = input;
  if (!live.readable || !live.version) return 'unsupported';
  if (live.injectionState === 'ambiguous') return 'unsupported';

  if (live.injectionState === 'absent') {
    if (!manifest) return 'unpatched';

    if (live.sha256 === manifest.baselineSha256) return 'unpatched';
    return 'modified';
  }

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
