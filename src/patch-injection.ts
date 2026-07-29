// src/patch-injection.ts — Leverframe patch-marker recognition.
//
// Shared marker-classification logic used by the V2 per-target patch
// transaction (src/patch-transaction.ts) so every caller agrees about what
// counts as "this binary carries our patch."

export const LEVERFRAME_INJECTION_MARKER = '/*leverframe:patch:v1*/';

export type InjectionState = 'present' | 'absent' | 'ambiguous';

export interface InjectionClassification {
  state: InjectionState;
  evidence: 'marker-v1' | 'manifest-hash' | 'ccpatch' | 'none' | 'unknown-marker';
}

export function classifyVersionedMarker(content: string): InjectionClassification {
  const markers = content.match(/\/\*leverframe:patch:[^*]*\*\//g) ?? [];
  const markerPrefixes = content.split('/*leverframe:patch:').length - 1;
  if (markerPrefixes !== markers.length) {
    return { state: 'ambiguous', evidence: 'unknown-marker' };
  }
  if (markers.length === 0) {
    return { state: 'absent', evidence: 'none' };
  }
  return markers.length === 1 && markers[0] === LEVERFRAME_INJECTION_MARKER
    ? { state: 'present', evidence: 'marker-v1' }
    : { state: 'ambiguous', evidence: 'unknown-marker' };
}

/**
 * Classify injection from content plus an already-known patched hash for this
 * exact path (or undefined if none is known). Used directly by the V2
 * transaction, which tracks patched hashes per canonical path rather than in a
 * single global manifest.
 */
export function classifyLeverframeInjectionByHash(
  content: string,
  sha256: string,
  knownPatchedSha256: string | undefined,
): InjectionClassification {
  const marker = classifyVersionedMarker(content);
  if (marker.state !== 'absent') return marker;
  if (content.includes('/*ccpatch:ctx*/')) return { state: 'present', evidence: 'ccpatch' };
  if (knownPatchedSha256 && knownPatchedSha256.length > 0 && knownPatchedSha256 === sha256) {
    return { state: 'present', evidence: 'manifest-hash' };
  }
  return marker;
}

export function addLeverframeInjectionMarker(content: string): string {
  const marker = classifyVersionedMarker(content);
  if (marker.state === 'ambiguous') {
    throw new Error('leverframe patch: unrecognized injection marker');
  }
  return marker.state === 'present' ? content : `${content}\n${LEVERFRAME_INJECTION_MARKER}`;
}
