import type { PatchSiteResult } from './patch-transforms.js';
import { ROUTING_NOTICE_REQUEST_PREFIX } from './patch-transforms-routing-notice-host.js';
import { ROUTING_AUXILIARY_REQUEST_PREFIX } from './patch-transforms-routing-auxiliary-guard.js';

const NAME = 'Routing model preparation bounds';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const MODULES = ['/$bunfs/root/chunk-3pr91mb5.js', '/$bunfs/root/chunk-pwf6g3a4.js',
  '/$bunfs/root/chunk-z2g9tcvz.js', '/$bunfs/root/chunk-sq7yspzm.js'];
const MARKER = '/*ccpatch:routing-preparation-bounds*/';
const DECLARATION = `${MARKER}import{yUe as __lfModelMeta}from"/$bunfs/root/chunk-bqbyxpv1.js";`
  + 'function __lfRequireBounds(id){let m=__lfModelMeta(id),r=m?.runtime,c=r?.max_input_tokens??m?.context_window,o=r?.max_output_tokens;'
  + 'if(!Number.isSafeInteger(c)||c<=0||!Number.isSafeInteger(o)||o<=0)throw Error("Routing model bounds unavailable")}'
  + 'function __lfRequireOutput(id,value){let cap=__lfModelMeta(id)?.runtime?.max_output_tokens;'
  + 'if(!Number.isSafeInteger(cap)||cap<=0||!Number.isSafeInteger(value)||value<=0||value>cap)throw Error("Routing output limit exceeded");return value}';

export function applyRoutingBoundsTransform(source: string, options: { enabled: boolean; visibleModelId: string }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing disabled');
  if (!options.visibleModelId) return result(source, 'FAIL', 'routing identity is unavailable');
  const anchors: Array<[string, string]> = [
    ['h={...h,effort:__lfRoute.effort};', 'h={...h,effort:__lfRoute.effort};__lfRequireBounds(__lfRoute.policyModelId);'],
    ['P={...P,effort:__lfResume.effort};', 'P={...P,effort:__lfResume.effort};__lfRequireBounds(__lfResume.policyModelId);'],
    ['async function pS({session:e,tools:n,runtimeModel:r,customSystemPrompt:s,appendSystemPrompt:h,appendSystemPromptHead:y,excludeDynamicSections:w,cacheBreakerPhrase:P,mcpClients:b,storageV5:A,credentials:L}){fh("before_getSystemPrompt");',
      'async function pS({session:e,tools:n,runtimeModel:r,customSystemPrompt:s,appendSystemPrompt:h,appendSystemPromptHead:y,excludeDynamicSections:w,cacheBreakerPhrase:P,mcpClients:b,storageV5:A,credentials:L}){__lfRequireBounds(r);fh("before_getSystemPrompt");'],
    ['max_tokens:cS,thinking:Jm', 'max_tokens:__lfRequireOutput(Z.model,cS),thinking:Jm'],
  ];
  const modules = MODULES.map(name => BOUNDARY + name + '\n');
  if (source.includes(MARKER)) {
    return modules.every(marker => {
      if (source.split(marker).length !== 2) return false;
      const start = source.indexOf(marker) + marker.length;
      const next = source.indexOf(BOUNDARY, start);
      const module = source.slice(start, next < 0 ? source.length : next);
      const positioned = source.split(marker + DECLARATION).length === 2
        || (marker.endsWith('/chunk-sq7yspzm.js\n')
          && source.split(marker + ROUTING_AUXILIARY_REQUEST_PREFIX + ROUTING_NOTICE_REQUEST_PREFIX + DECLARATION).length === 2);
      return positioned && module.split(DECLARATION).length === 2;
    })
      && anchors.every(([, replacement]) => source.split(replacement).length === 2)
      ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing bounds patch is incomplete or changed');
  }
  if (modules.some(marker => source.split(marker).length !== 2)
    || anchors.some(([anchor]) => source.split(anchor).length !== 2)) return result(source, 'FAIL', 'routing bounds anchors are unavailable');
  let changed = source;
  for (const marker of modules) changed = changed.replace(marker, marker + DECLARATION);
  for (const [anchor, replacement] of anchors) changed = changed.replace(anchor, replacement);
  return result(changed, 'OK');
}
