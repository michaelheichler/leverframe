import type { PatchSiteResult } from './patch-transforms.js';

const NAME = 'Routing binding sidecar';
const MARKER = '/*ccpatch:routing-binding-sidecar*/';

export function applyRoutingSidecarTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing disabled');
  const anchors: Array<[string, string]> = [
    ['lPt=[...G9s,"restartResumes"];', `${MARKER}lPt=[...G9s,"restartResumes","leverframeRoutingBinding"];`],
    ['[{type:"agent_metadata",agentType:y.agentType,', '[{type:"agent_metadata",...Object.hasOwn(y,"leverframeRoutingBinding")&&{leverframeRoutingBinding:y.leverframeRoutingBinding},agentType:y.agentType,'],
    ['return{agentType:n,...typeof r==="boolean"', 'return{...Object.hasOwn(e,"leverframeRoutingBinding")&&{leverframeRoutingBinding:e.leverframeRoutingBinding},agentType:n,...typeof r==="boolean"'],
    ['Jd(Se,sn,{agentType:e.agentType,', `${MARKER}let __lfSidecar=Jd(Se,sn,{...__lfBinding&&{leverframeRoutingBinding:__lfBinding},agentType:e.agentType,`],
    ['...qt},r.storageV5).catch(Qd);let Ao=', '...qt},r.storageV5).catch(err=>{if(__lfBinding)throw err;Qd(err)});if(__lfBinding)await __lfSidecar;let Ao='],
  ];
  if (source.includes(MARKER)) {
    return anchors.every(([, replacement]) => source.split(replacement).length === 2)
      ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing sidecar patch is incomplete');
  }
  if (anchors.some(([anchor]) => source.split(anchor).length !== 2)) return result(source, 'FAIL', 'routing sidecar anchors are unavailable');
  let changed = source;
  for (const [anchor, replacement] of anchors) changed = changed.replace(anchor, replacement);
  return result(changed, 'OK');
}
