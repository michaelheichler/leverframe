import type { PatchSiteResult } from './patch-transforms.js';

const NAME = 'Main router identity';
const MARKER = '/*ccpatch:main-router-identity*/';

export function applyMainRoutingTransform(source: string, options: { enabled: boolean; visibleModelId: string; policyModelId: string;
  metadata?: { contextWindow?: number; maxOutputTokens?: number; supportedReasoningEfforts?: string[] };
  targetMetadata?: Record<string, { contextWindow?: number; maxOutputTokens?: number; supportedReasoningEfforts?: string[] }> }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing disabled');
  if (!options.visibleModelId || !options.policyModelId || options.visibleModelId === options.policyModelId) {
    return result(source, 'FAIL', 'routing identity is unavailable');
  }
  const metadata = options.metadata;
  const targets = { ...(metadata ? { [options.policyModelId]: metadata } : {}), ...options.targetMetadata };
  if (Object.values(targets).some(value => !value || typeof value !== 'object'
    || [value.contextWindow, value.maxOutputTokens].some(number => number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
    || (value.supportedReasoningEfforts !== undefined && (!Array.isArray(value.supportedReasoningEfforts)
      || value.supportedReasoningEfforts.some(effort => typeof effort !== 'string' || !effort.trim()))))) {
    return result(source, 'FAIL', 'routing model metadata is invalid');
  }
  const targetJson = JSON.stringify(JSON.stringify(targets));
  const visible = JSON.stringify(options.visibleModelId);
  const concrete = JSON.stringify(options.policyModelId);
  const anchors: Array<[string, string]> = [
    ['function ro(e,n){try{if(gOe(e))', `function ro(e,n){${MARKER}if(e===${visible}){let p=${concrete},o;if(n?.overridesMap!==void 0)o=Rw(p,n.overridesMap);else if(n?.ignoreModelOverrides)o=p;else{let x=Se("policySettings");o=x?.availableModels!==void 0?Rw(p,x.modelOverrides??Cge()??{}):HTn(p)}if(o!==p||!ro(p,n)||Ut(p)!==p||LT(p)!==p)throw Error("Routing model was restricted or overridden");return!0}try{if(gOe(e))`],
    ['function Ut(e){return zP(hV(sG(e)))}', `function Ut(e){return e===${visible}?e:zP(hV(sG(e)))}`],
    ['function LT(e){let n=jn(e),r=n.toLowerCase();', `function LT(e){if(e===${visible})return e;let n=jn(e),r=n.toLowerCase();`],
    ['function yUe(...e){return Xy(ln(),e)}', `function yUe(...e){let a=e.map(v=>v===${visible}?${concrete}:v),n=Xy(ln(),a),t=JSON.parse(${targetJson}),k=a[0],m=Object.hasOwn(t,k)?t[k]:void 0;if(m&&n?.id!==k)n=void 0;if(!m&&n&&Object.hasOwn(t,n.id)){k=n.id;m=t[k]}if(!m&&!n){k=a.slice(1).find(v=>Object.hasOwn(t,v));m=k===void 0?void 0:t[k]}if(!m)return n;return{...n,id:n?.id??k,...m.contextWindow!==void 0&&{context_window:m.contextWindow},runtime:{...n?.runtime,...m.contextWindow!==void 0&&{max_input_tokens:m.contextWindow},...m.maxOutputTokens!==void 0&&{max_output_tokens:m.maxOutputTokens},...m.supportedReasoningEfforts!==void 0&&{effort_levels:m.supportedReasoningEfforts}}}}`],
    ['function nkn(e){let n=le(e)', `function nkn(e){if(e===${visible})e=${concrete};let n=le(e)`],
    ['function _p({userSpecifiedModel:e,permissionMode:n,thinkingConfig:r}){let s=', `function _p({userSpecifiedModel:e,permissionMode:n,thinkingConfig:r}){if(e===${visible})ro(e);let s=`],
    ['h=fy({permissionMode:n,mainLoopModel:s});return{mainLoopModel:s,runtimeModel:h,thinkingConfig:r?', `h=fy({permissionMode:n,mainLoopModel:s});if(e===${visible}&&(s!==${visible}||h!==${visible}))throw Error("Routing model changed");return{mainLoopModel:s,runtimeModel:h,thinkingConfig:r?`],
  ];
  if (source.includes(MARKER)) {
    return anchors.every(([, replacement]) => source.split(replacement).length === 2)
      ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'main routing patch is incomplete or changed');
  }
  if (anchors.some(([anchor]) => source.split(anchor).length !== 2)) return result(source, 'FAIL', 'main router anchors are unavailable');
  let changed = source;
  for (const [anchor, replacement] of anchors) changed = changed.replace(anchor, replacement);
  return result(changed, 'OK');
}
