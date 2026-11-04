import type { PatchSiteResult } from './patch-transforms.js';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from './constants.js';
import { ROUTING_NOTICE_FORMAT_SOURCE } from './patch-transforms-routing-notice-format.js';
import { ROUTING_NOTICE_COORDINATOR_SOURCE } from './patch-transforms-routing-notice-coordinator.js';
import { ROUTING_AUXILIARY_REQUEST_PREFIX } from './patch-transforms-routing-auxiliary-guard.js';

const NAME = 'Routing notice host and request gate';
const MARKER = '/*ccpatch:routing-notice-host*/';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const HOST = `${BOUNDARY}/$bunfs/root/chunk-01y36vdn.js\n`;
const REQUEST = `${BOUNDARY}/$bunfs/root/chunk-sq7yspzm.js\n`;
const ACTIVE = `process.env[${JSON.stringify(ROUTING_ACTIVE_ENV)}]===${JSON.stringify(ROUTING_ACTIVE_VALUE)}`;
const NOTICE_ACTIVE = `process.env[${JSON.stringify(ROUTING_NOTICE_ACTIVE_ENV)}]===${JSON.stringify(ROUTING_ACTIVE_VALUE)}`;
const HOST_SOURCE = `${MARKER}${ROUTING_NOTICE_FORMAT_SOURCE}\n${ROUTING_NOTICE_COORDINATOR_SOURCE}`
  + `function __lfAttachNotice(session,add,remove,renderer,ref){if(!(${NOTICE_ACTIVE})||!session||!renderer)return;`
  + 'let owner=ref.current??=( {} ),old=session.__lfNoticeAttachment;'
  + 'if(old&&(old.owner!==owner||old.renderer!==renderer))old.bridge.close();'
  + 'let bridge=renderer.__lfNoticeBridge;if(!bridge||bridge.session!==session||old?.owner!==owner||old?.bridge!==bridge){'
  + 'bridge?.close();bridge=__lfCreateNoticeBridge(renderer,session,add,remove,()=>z());renderer.__lfNoticeBridge=bridge}'
  + 'bridge.setPublisher(add,remove);session.__lfNoticeAttachment={owner,renderer,bridge}}'
  + 'function __lfDetachNotice(session,owner){let entry=session?.__lfNoticeAttachment;if(!entry||entry.owner!==owner)return;'
  + 'session.__lfNoticeAttachment=void 0;if(entry.renderer.__lfNoticeBridge===entry.bridge)entry.renderer.__lfNoticeBridge=void 0;entry.bridge.close()}';
const REQUEST_SOURCE = `${MARKER}import{ai as __lfNoticeAi}from"/$bunfs/root/chunk-f5200rjz.js";`
  + 'async function __lfAwaitNoticeHost(session,signal){if(!signal||signal.aborted)throw Error("Routing notice consumer unavailable");'
  + 'let deadline=Date.now()+15000;while(Date.now()<deadline&&!signal.aborted){'
  + 'let renderer=__lfNoticeAi().get(process.stdout),bridge=renderer?.__lfNoticeBridge;'
  + 'if(bridge){let ready=await bridge.ensure(session,signal,deadline);if(!ready||signal.aborted||Date.now()>=deadline||z()!==session||'
  + '__lfNoticeAi().get(process.stdout)!==renderer||renderer.__lfNoticeBridge!==bridge||bridge.session?.id!==session||'
  + 'renderer.__lfOutputAbort?.signal.aborted!==!1||!renderer.nonBlockingStdout?.routingReady?.())throw Error("Routing notice consumer unavailable");return}'
  + 'await new Promise((yes,no)=>{let t=setTimeout(done,25);function done(){signal.removeEventListener("abort",cancel);yes()}'
  + 'function cancel(){clearTimeout(t);signal.removeEventListener("abort",cancel);no(Error("Routing notice consumer unavailable"))}'
  + 'signal.addEventListener("abort",cancel,{once:!0});if(signal.aborted)cancel()})}'
  + 'throw Error("Routing notice consumer unavailable")}';

export const ROUTING_NOTICE_REQUEST_PREFIX = REQUEST_SOURCE;

export function applyRoutingNoticeHostTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing notice host disabled');
  const modules: Array<{ marker: string; replacements: Array<[string, string]> }> = [
    { marker: HOST, replacements: [
      [HOST, HOST + HOST_SOURCE],
      ['lr=no(),Sr=', 'lr=no(),__lfNoticeOwner=A(null),Sr='],
      ['cs.bindHost({store:tr,setAppState:Ar', '__lfAttachNotice(lr,js,Pr,ai().get(process.stdout),__lfNoticeOwner),cs.bindHost({store:tr,setAppState:Ar'],
      ['zt(K_);', 'zt(K_);zt(()=>{let owner=__lfNoticeOwner.current??=( {} );return()=>__lfDetachNotice(lr,owner)},[lr]);'],
    ] },
    { marker: REQUEST, replacements: [
      [REQUEST, REQUEST + REQUEST_SOURCE],
      ['async function*Fhn(e,n,r,s,h,{modelFacts:y,...b}){let',
        `async function*Fhn(e,n,r,s,h,{modelFacts:y,...b}){if(${ACTIVE}||b.agentContext?.leverframeRoutingBinding||(typeof __lfRecoveryCurrent==="function"&&__lfRecoveryCurrent()?.kind==="bound"))await __lfAwaitNoticeHost(z(),h);let`],
    ] },
  ];
  const slices = modules.map(({ marker, replacements }) => {
    const start = source.indexOf(marker);
    if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) return undefined;
    const next = source.indexOf(BOUNDARY, start + marker.length);
    return { start, end: next < 0 ? source.length : next, replacements };
  });
  if (slices.some(slice => !slice)) return result(source, 'FAIL', 'routing notice host modules are unavailable');
  const existing = slices.map(slice => source.slice(slice!.start, slice!.end));
  if (existing.some(value => value.includes(MARKER))) return slices.every((slice, index) =>
    slice!.replacements.every(([anchor, replacement]) => {
      const module = existing[index]!;
      if (anchor === REQUEST) return module.split(REQUEST_SOURCE).length === 2
        && (module.split(replacement).length === 2
          || module.split(REQUEST + ROUTING_AUXILIARY_REQUEST_PREFIX + REQUEST_SOURCE).length === 2);
      return module.split(replacement).length === 2
        && (anchor !== HOST || module.split(replacement.slice(anchor.length)).length === 2);
    }))
    ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing notice host patch is incomplete');
  if (slices.some((slice, index) => slice!.replacements.some(([anchor]) => existing[index]!.split(anchor).length !== 2))) {
    return result(source, 'FAIL', 'routing notice host anchors are unavailable');
  }
  let content = source;
  for (const slice of slices.sort((a, b) => b!.start - a!.start)) {
    let module = content.slice(slice!.start, slice!.end);
    for (const [anchor, replacement] of slice!.replacements) module = module.replace(anchor, replacement);
    content = content.slice(0, slice!.start) + module + content.slice(slice!.end);
  }
  return result(content, 'OK');
}
