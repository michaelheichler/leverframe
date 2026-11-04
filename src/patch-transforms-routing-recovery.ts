import type { PatchSiteResult } from './patch-transforms.js';
import { applyRoutingSidecarTransform } from './patch-transforms-routing-sidecar.js';
import { ROUTING_CONTROL_ERROR_READER } from './patch-transforms-control-error.js';
import { ROUTING_HANDOFF_LIMIT, ROUTING_SNAPSHOT_LABEL } from './constants.js';
import { ROUTING_NOTICE_REQUEST_PREFIX } from './patch-transforms-routing-notice-host.js';
import { ROUTING_AUXILIARY_REQUEST_PREFIX } from './patch-transforms-routing-auxiliary-guard.js';

const NAME = 'Routing recovery scope';
const MARKER = '/*ccpatch:routing-recovery-scope*/';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const META = '/$bunfs/root/chunk-bqbyxpv1.js';
const RESUME = '/$bunfs/root/chunk-pwf6g3a4.js';
const LAUNCH = '/$bunfs/root/chunk-3pr91mb5.js';
const RUNNER = '/$bunfs/root/chunk-430w8txz.js';
const REQUEST = '/$bunfs/root/chunk-sq7yspzm.js';
const RESUME_IMPORT = 'import{et,ve,Sp,_e,Kve,X,wde,Rre,I_}from"/$bunfs/root/chunk-ne3vazsy.js";';
const LOOKUP = 'await (async()=>{const base=process.env.LEVERFRAME_CONTEXT_SELECTION_BASE_URL,token=process.env.LEVERFRAME_CONTEXT_SELECTION_TOKEN;'
  + ROUTING_CONTROL_ERROR_READER
  + 'if(!h||typeof h!=="object"||Array.isArray(h)||typeof h.agentType!=="string"||!h.agentType.trim()||!token||typeof base!=="string")throw Error("Routing recovery unavailable");'
  + 'const u=new URL("/v1/leverframe/routing-recovery",base);if(u.protocol!=="http:"||u.hostname!=="127.0.0.1")throw Error("Routing recovery unavailable");'
  + 'const response=await fetch(u,{method:"POST",redirect:"error",signal:AbortSignal.any([r.abortController.signal,AbortSignal.timeout(30000)]),headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},'
  + 'body:JSON.stringify({sessionId:__lfSession(),launchId:String(e),sidecarValid:true,agentType:h.agentType,marker:h.leverframeRoutingBinding})});'
  + 'if(!response.ok){let e=await __lfControlError(response);throw Error("Routing recovery failed: "+(e||response.status))}const b=await response.json();'
  + 'if(b?.kind==="unbound"){if(h.leverframeRoutingBinding!==void 0)throw Error("Routing recovery marker mismatch");return{kind:"unbound"}}'
  + 'if(b?.kind!=="bound"||typeof b.modelId!=="string"||b.modelId!==h.leverframeRoutingBinding||typeof b.policyModelId!=="string"||!b.policyModelId||!b.metadata||typeof b.metadata!=="object"||Array.isArray(b.metadata))throw Error("Routing recovery unavailable");'
  + `if(!b.handoff||b.handoff.version!==1||b.handoff.agentType!==h.agentType||typeof b.handoff.reviewedTask!=="string"||Buffer.byteLength(b.handoff.reviewedTask,"utf8")>${ROUTING_HANDOFF_LIMIT})throw Error("The saved routing handoff is unavailable. Start a new agent.");`
  + 'for(const k of ["contextWindow","maxOutputTokens"])if(b.metadata[k]!==void 0&&(!Number.isSafeInteger(b.metadata[k])||b.metadata[k]<=0))throw Error("Routing recovery metadata invalid");'
  + 'if(b.metadata.supportedReasoningEfforts!==void 0&&(!Array.isArray(b.metadata.supportedReasoningEfforts)||b.metadata.supportedReasoningEfforts.some(v=>typeof v!=="string"||!v.trim())))throw Error("Routing recovery metadata invalid");'
  + 'if(b.effort!==void 0&&(typeof b.effort!=="string"||!b.effort.trim()))throw Error("Routing recovery metadata invalid");'
  + 'const m=Object.freeze({contextWindow:b.metadata.contextWindow,maxOutputTokens:b.metadata.maxOutputTokens,supportedReasoningEfforts:b.metadata.supportedReasoningEfforts===void 0?void 0:Object.freeze([...b.metadata.supportedReasoningEfforts])});'
  + 'const handoff=Object.freeze({version:1,agentType:b.handoff.agentType,reviewedTask:b.handoff.reviewedTask});'
  + 'return Object.freeze({kind:"bound",modelId:b.modelId,policyModelId:b.policyModelId,effort:b.effort,metadata:m,handoff})})()';
const DECLARATION = `${MARKER}import{AsyncLocalStorage as __lfRecoveryALS}from"node:async_hooks";`
  + 'const __lfRecoveryStorage=new __lfRecoveryALS();'
  + 'function __lfRecoveryRun(s,f){return __lfRecoveryStorage.run(s,f)}function __lfRecoveryCurrent(){return __lfRecoveryStorage.getStore()}'
  + 'function __lfRecoveryIterator(s,i){return{[Symbol.asyncIterator](){return this},next(...a){return __lfRecoveryRun(s,()=>i.next(...a))},'
  + 'return(...a){return __lfRecoveryRun(s,()=>i.return(...a))},throw(...a){return __lfRecoveryRun(s,()=>i.throw(...a))}}}'
  + 'function __lfRecoveryBounds(id){let m=yUe(id),r=m?.runtime,c=r?.max_input_tokens??m?.context_window,o=r?.max_output_tokens;'
  + 'if(!Number.isSafeInteger(c)||c<=0||!Number.isSafeInteger(o)||o<=0)throw Error("Routing model bounds unavailable");return o}'
  + 'export{__lfRecoveryRun,__lfRecoveryCurrent,__lfRecoveryIterator,__lfRecoveryBounds};';

export function applyRoutingRecoveryTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'recovery disabled');
  const metaBoundary = BOUNDARY + META + '\n';
  const imports: Array<[string, string]> = [
    [BOUNDARY + RESUME + '\n', 'import{__lfRecoveryRun,__lfRecoveryCurrent,__lfRecoveryIterator,__lfRecoveryBounds}from"/$bunfs/root/chunk-bqbyxpv1.js";'],
    [BOUNDARY + LAUNCH + '\n', 'import{__lfRecoveryCurrent}from"/$bunfs/root/chunk-bqbyxpv1.js";'],
    [BOUNDARY + RUNNER + '\n', 'import{__lfRecoveryCurrent}from"/$bunfs/root/chunk-bqbyxpv1.js";'],
    [BOUNDARY + REQUEST + '\n', 'import{__lfRecoveryCurrent,__lfRecoveryBounds}from"/$bunfs/root/chunk-bqbyxpv1.js";'],
  ];
  const resolve = 'jG(iAe(P,dn),dn,h?.isObserver?void 0:C?"inherit":h?.model,Be)';
  const policy = 'jG(iAe(P,dn),dn,__lfRecovery.policyModelId,Be)';
  const rmr = 'RMr({agentDefinition:P,isFork:C,model:Ye,effortState:Ue.getAppState(),inheritedLayers:Ue.permissionLayers,recordedBudgetText:C?xn(Q):yt})';
  const stream = 'tP({...Sn,session:kt,override:{...Sn.override,agentId:Or(Y.agentId),agentContext:Mt,abortController:Y.abortController},onCacheSafeParams:n,onQueryProgress:w,onStreamTokenEstimate:b,...K!==void 0&&ee&&!gt&&{canShowPermissionPrompts:!1}})';
  const resolveRunner = 'Xe=EKs(iAe(e,dt),dt,Z,Le,lo,Tt?void 0:He?"resume":"spawn",{inWorkflowRun:we!==void 0||!He&&!Tt&&r.spawnedByWorkflowRunId!==void 0}),Ot=Xe';
  const resumeMessages = 'promptMessages:E?Q:[...Q,...bn,...mn,Xe]';
  const recoveredMessages = 'promptMessages:(()=>{if(__lfRecovery.kind!=="bound")return E?Q:[...Q,...bn,...mn,Xe];'
    + 'let h=__lfRecovery.handoff;if(!h||h.agentType!==P.agentType)throw Error("The saved routing handoff is unavailable. Start a new agent.");'
    + `let q=h.reviewedTask,s=${JSON.stringify(ROUTING_SNAPSHOT_LABEL)}+q,found=Q.some(m=>m.type==="user"&&!m.isMeta&&m.toolUseResult===void 0&&`
    + 'm.message?.role==="user"&&typeof m.message.content==="string"&&(m.message.content===q||m.message.content===s));'
    + 'if(E&&!found)throw Error("The interrupted agent lacks its launch snapshot. Start a new agent.");'
    + 'return E?Q:[...Q,...(found?[]:[Oe({content:s})]),...mn,Xe]})()';
  const anchors: Array<[string, string]> = [
    [metaBoundary, metaBoundary + DECLARATION],
    ...imports.map(([marker, declaration]): [string, string] => [marker, marker + declaration]),
    [RESUME_IMPORT, RESUME_IMPORT.replace('{et,', '{z as __lfSession,et,')],
    ['function yUe(...e){return Xy(ln(),e)}', 'function yUe(...e){let n=Xy(ln(),e),s=__lfRecoveryCurrent();if(!s||s.kind!=="bound")return n;let k=e[0];if(k===s.policyModelId){if(n?.id!==k)n=void 0}else if(n?.id===s.policyModelId)k=n.id;else if(!n&&e.slice(1).includes(s.policyModelId))k=s.policyModelId;else return n;let m=s.metadata;return{...n,id:n?.id??k,...m.contextWindow!==void 0&&{context_window:m.contextWindow},runtime:{...n?.runtime,...m.contextWindow!==void 0&&{max_input_tokens:m.contextWindow},...m.maxOutputTokens!==void 0&&{max_output_tokens:m.maxOutputTokens},...m.supportedReasoningEfforts!==void 0&&{effort_levels:[...m.supportedReasoningEfforts]}}}}'],
    ['let dn=fc(r),Ye=' + resolve + ',yt=', `let __lfRecovery=${LOOKUP};if(__lfRecovery.kind==="unbound"&&__lfRecoveryCurrent())throw Error("Nested agents are unavailable during routing recovery");if(__lfRecovery.kind==="bound"){if(X()||h?.isObserver||C)throw Error("Routing recovery mode is unsupported");P={...P,effort:__lfRecovery.effort};sn=__lfRecovery.effort}let dn=fc(r),Ye=__lfRecovery.kind==="bound"?__lfRecoveryRun(__lfRecovery,()=>{__lfRecoveryBounds(__lfRecovery.policyModelId);let m=${policy};if(m!==__lfRecovery.policyModelId)throw Error("Routing model was restricted");return m}):${resolve},yt=`],
    [rmr, `(__lfRecovery.kind==="bound"?__lfRecoveryRun(__lfRecovery,()=>${rmr}):${rmr})`],
    ['model:h?.isObserver?void 0:C?"inherit":h?.model,effort:sn,', 'model:__lfRecovery.kind==="bound"?__lfRecovery.policyModelId:h?.isObserver?void 0:C?"inherit":h?.model,effort:sn,...__lfRecovery.kind==="bound"&&{routingBinding:__lfRecovery.modelId},'],
    [resumeMessages, recoveredMessages],
    [stream, `(__lfRecovery.kind==="bound"?__lfRecoveryIterator(__lfRecovery,${stream}):${stream})`],
    ['session:xe,spawnMode:Ne', 'routingBinding:__lfBinding,session:xe,spawnMode:Ne'],
    ['callerDeliveredReport:We}){let At=', 'callerDeliveredReport:We}){let __lfCurrent=__lfRecoveryCurrent();if((__lfCurrent||__lfBinding)&&(!__lfCurrent||__lfCurrent.modelId!==__lfBinding))throw Error("Routing recovery scope is unavailable");let At='],
    [resolveRunner, resolveRunner.replace('Ot=Xe', 'Ot=__lfBinding&&Xe!==Z?(()=>{throw Error("Routing model was restricted")})():Xe')],
    ['async function Xo({agentInput:n,toolUseContext:e,canUseTool:s,assistantMessage:p,onProgress:y,timing:_,enclosingToolUseId:k}){let', 'async function Xo({agentInput:n,toolUseContext:e,canUseTool:s,assistantMessage:p,onProgress:y,timing:_,enclosingToolUseId:k}){if(__lfRecoveryCurrent())throw Error("New agents are unavailable during routing recovery");let'],
    ['if(w?.onRetryStatus)tt.onRetryStatus=w.onRetryStatus;', 'if(__lfBinding)tt.agentContext={...tt.agentContext,leverframeRoutingBinding:__lfBinding,leverframeRoutingPolicyModel:Z};if(w?.onRetryStatus)tt.onRetryStatus=w.onRetryStatus;'],
    ['model:LT(Z.model),messages:R_!==null', 'model:(()=>{const a=Z.agentContext;if(a?.leverframeRoutingBinding){if(a.leverframeRoutingPolicyModel!==Z.model)throw Error("Routing model changed");return a.leverframeRoutingBinding}return LT(Z.model)})(),messages:R_!==null'],
    ['max_tokens:cS,thinking:Jm', 'max_tokens:(()=>{let s=__lfRecoveryCurrent();if(!s)return cS;if(s.policyModelId!==Z.model||!Number.isSafeInteger(cS)||cS<=0||cS>__lfRecoveryBounds(Z.model))throw Error("Routing output limit exceeded");return cS})(),thinking:Jm'],
  ];
  if (source.includes(MARKER)) {
    const complete = anchors.every(([anchor, replacement]) => {
      if (!anchor.startsWith(BOUNDARY)) return source.split(replacement).length === 2;
      if (source.split(anchor).length !== 2) return false;
      const start = source.indexOf(anchor) + anchor.length;
      const next = source.indexOf(BOUNDARY, start);
      const module = source.slice(start, next < 0 ? source.length : next);
      const positioned = source.split(replacement).length === 2
        || (anchor === BOUNDARY + REQUEST + '\n' && source.split(anchor + ROUTING_AUXILIARY_REQUEST_PREFIX
          + ROUTING_NOTICE_REQUEST_PREFIX + replacement.slice(anchor.length)).length === 2);
      return positioned && module.split(replacement.slice(anchor.length)).length === 2;
    });
    const sidecar = applyRoutingSidecarTransform(source, { enabled: true });
    return complete && sidecar.results.every(item => item.status === 'SKIP')
      ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing recovery patch is incomplete or changed');
  }
  if (anchors.some(([anchor]) => source.split(anchor).length !== 2)) return result(source, 'FAIL', 'routing recovery anchors are unavailable');
  let changed = source;
  for (const [anchor, replacement] of anchors) changed = changed.replace(anchor, replacement);
  const sidecar = applyRoutingSidecarTransform(changed, { enabled: true });
  if (sidecar.results.some(item => item.status === 'FAIL')) return result(source, 'FAIL', 'routing recovery sidecar anchors are unavailable');
  return result(sidecar.content, 'OK');
}
