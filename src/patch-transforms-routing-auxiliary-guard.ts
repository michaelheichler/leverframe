import type { PatchSiteResult } from './patch-transforms.js';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from './constants.js';

const NAME = 'Routing auxiliary request guard';
const MARKER = '/*ccpatch:routing-auxiliary-guard*/';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const CORE = `${BOUNDARY}/$bunfs/root/chunk-dzek3cak.js\n`;
const REQUEST = `${BOUNDARY}/$bunfs/root/chunk-sq7yspzm.js\n`;
const ACTIVE = `process.env[${JSON.stringify(ROUTING_ACTIVE_ENV)}]===${JSON.stringify(ROUTING_ACTIVE_VALUE)}`;
const NOTICE_ACTIVE = `process.env[${JSON.stringify(ROUTING_NOTICE_ACTIVE_ENV)}]===${JSON.stringify(ROUTING_ACTIVE_VALUE)}`;
const guard = (name: string) => `${MARKER}async function ${name}(){`
  + `if(${ACTIVE})throw Error("Auxiliary requests are unavailable during routing");`
  + `if(${NOTICE_ACTIVE}){let m=await import("/$bunfs/root/chunk-bqbyxpv1.js");`
  + 'if(typeof m.__lfRecoveryCurrent!=="function")throw Error("Routing recovery scope is unavailable");'
  + 'if(m.__lfRecoveryCurrent()?.kind==="bound")throw Error("Auxiliary requests are unavailable during routing recovery")}}';

export const ROUTING_AUXILIARY_REQUEST_PREFIX = guard('__lfGuardAuxRequest');

export function applyRoutingAuxiliaryGuardTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing auxiliary guard disabled');
  const modules: Array<{ marker: string; replacements: Array<[string, string]> }> = [
    { marker: CORE, replacements: [
      [CORE, CORE + guard('__lfGuardAuxCore')],
      ['async function et(e,n,r){let s=await EN(', 'async function et(e,n,r){await __lfGuardAuxCore();let s=await EN('],
    ] },
    { marker: REQUEST, replacements: [
      [REQUEST, REQUEST + ROUTING_AUXILIARY_REQUEST_PREFIX],
      ['async function QVe(e,n,r,s){if(X())return null;', 'async function QVe(e,n,r,s){if(X())return null;try{await __lfGuardAuxRequest()}catch{return null;}'],
      ['async function axo(e,n,r){e=W1e(e);', 'async function axo(e,n,r){await __lfGuardAuxRequest();e=W1e(e);'],
      ['async function I5s(e,n,r,s){if(n)return!0;try{', 'async function I5s(e,n,r,s){if(n)return!0;await __lfGuardAuxRequest();try{'],
      ['Mr=(ds)=>{let $i=_s();', 'Mr=async(ds)=>{await __lfGuardAuxRequest();let $i=_s();'],
    ] },
  ];
  const slices = modules.map(({ marker, replacements }) => {
    const start = source.indexOf(marker);
    if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) return undefined;
    const next = source.indexOf(BOUNDARY, start + marker.length);
    return { start, end: next < 0 ? source.length : next, replacements };
  });
  if (slices.some(slice => !slice)) return result(source, 'FAIL', 'routing auxiliary guard modules are unavailable');
  const existing = slices.map(slice => source.slice(slice!.start, slice!.end));
  if (existing.some(value => value.includes(MARKER))) return slices.every((slice, index) =>
    slice!.replacements.every(([anchor, replacement]) => {
      const module = existing[index]!;
      return module.split(replacement).length === 2
        && (!(anchor === CORE || anchor === REQUEST) || module.split(replacement.slice(anchor.length)).length === 2);
    }))
    ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing auxiliary guard patch is incomplete');
  if (slices.some((slice, index) => slice!.replacements.some(([anchor]) => existing[index]!.split(anchor).length !== 2))) {
    return result(source, 'FAIL', 'routing auxiliary guard anchors are unavailable');
  }
  let content = source;
  for (const slice of slices.sort((a, b) => b!.start - a!.start)) {
    let module = content.slice(slice!.start, slice!.end);
    for (const [anchor, replacement] of slice!.replacements) module = module.replace(anchor, replacement);
    content = content.slice(0, slice!.start) + module + content.slice(slice!.end);
  }
  return result(content, 'OK');
}
