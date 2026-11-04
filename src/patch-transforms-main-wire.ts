import type { PatchSiteResult } from './patch-transforms.js';

const NAME = 'Main router outbound identity';
const ANCHOR = 'return LT(Z.model)})(),messages:R_!==null';
const MARKER = '/*ccpatch:main-router-wire*/';

export function applyMainRoutingWireGuard(source: string, options: { enabled: boolean; visibleModelId: string }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing disabled');
  if (!options.visibleModelId) return result(source, 'FAIL', 'routing identity is unavailable');
  const visible = JSON.stringify(options.visibleModelId);
  const replacement = `${MARKER}if(Z.model!==${visible})throw Error("Routing model changed before dispatch");${ANCHOR}`;
  if (source.includes(MARKER)) return source.split(replacement).length === 2
    ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'main router wire guard is incomplete or changed');
  if (source.split(ANCHOR).length !== 2) return result(source, 'FAIL', 'main router request anchor is unavailable');
  return result(source.replace(ANCHOR, replacement), 'OK');
}
