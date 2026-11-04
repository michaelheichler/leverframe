import type { PatchSiteResult } from './patch-transforms.js';

const NAME = 'Routing notice tracked output';
const MARKER = '/*ccpatch:routing-notice-writer*/';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const MODULE = `${BOUNDARY}/$bunfs/root/chunk-w2wf6pm6.js\n`;
const DECLARATION = `${MARKER}function __lfReject(e){let t=e.__lfTracked;if(!t)return;e.__lfTracked=void 0;clearTimeout(t.timer);`
  + 't.signal.removeEventListener("abort",t.cancel);t.out.removeListener("error",t.cancel);t.out.removeListener("close",t.cancel);try{t.no()}catch{}}'
  + 'function __lfInvalidate(e){e.__lfEpoch=(e.__lfEpoch??0)+1;e.__lfReady=void 0;e.__lfOut=void 0;__lfReject(e)}'
  + 'function __lfFinish(e){let t=e.__lfTracked;if(!t)return;'
  + 'if(t.signal.aborted||Date.now()>=t.deadline||process.stdout!==t.out||!t.out.isTTY||t.out.destroyed||t.out.writableEnded||t.out.errored||'
  + 'e.installedWrite===void 0||t.out.write!==e.installedWrite||e.__lfReady!==t.epoch||e.__lfEpoch!==t.epoch){__lfReject(e);return}'
  + 'e.__lfTracked=void 0;clearTimeout(t.timer);t.signal.removeEventListener("abort",t.cancel);'
  + 't.out.removeListener("error",t.cancel);t.out.removeListener("close",t.cancel);try{t.yes()}catch{try{t.no()}catch{}}}'
  + 'function __lfBarrier(e,expected,signal,deadline){return new Promise((yes,no)=>{__lfInvalidate(e);let out=process.stdout;'
  + 'if(!signal||signal.aborted||!Number.isFinite(deadline)||Date.now()>=deadline||!out.isTTY||out.destroyed||out.writableEnded||out.errored||'
  + 'e.installedWrite===void 0||out.write!==e.installedWrite||e.originalWrite!==expected||e.queue.length!==0||e.dropping){no(Error("Routing output barrier unavailable"));return}'
  + 'e.__lfEpoch??=0;let epoch=e.__lfEpoch,settled=!1,timer;const finish=(ok)=>{if(settled)return;settled=!0;clearTimeout(timer);'
  + 'signal.removeEventListener("abort",cancel);out.removeListener("error",cancel);out.removeListener("close",cancel);'
  + 'if(!ok||signal.aborted||Date.now()>=deadline||process.stdout!==out||!out.isTTY||out.destroyed||out.writableEnded||out.errored||'
  + 'e.__lfEpoch!==epoch||e.installedWrite===void 0||out.write!==e.installedWrite)'
  + '{no(Error("Routing output barrier failed"));return}e.__lfReady=epoch;e.__lfOut=out;yes()};const cancel=()=>finish(!1);'
  + 'signal.addEventListener("abort",cancel,{once:!0});out.once("error",cancel);out.once("close",cancel);'
  + 'timer=setTimeout(cancel,Math.min(2147483647,Math.max(1,deadline-Date.now())));'
  + 'try{e.originalWrite.call(out,"",(err)=>finish(!err))}catch{finish(!1)}if(signal.aborted)cancel()})}'
  + 'function __lfWriteTracked(e,data,signal,deadline,yes,no){if(typeof yes!=="function"||typeof no!=="function")throw Error("Invalid routing output token");'
  + 'if((typeof data!=="string"&&!Buffer.isBuffer(data))||!process.stdout.isTTY||process.stdout.destroyed||'
  + 'process.stdout.writableEnded||process.stdout.errored||!signal||signal.aborted||!Number.isFinite(deadline)||Date.now()>=deadline||'
  + 'e.installedWrite===void 0||process.stdout.write!==e.installedWrite||e.__lfTracked||e.queue.length!==0||e.dropping||'
  + 'e.__lfReady===void 0||e.__lfReady!==(e.__lfEpoch??0)){no();return}'
  + 'let n=Buffer.from(data);if(n.length===0||n.length>Q){no();return}let token={yes,no,signal,deadline,out:process.stdout,epoch:e.__lfReady};'
  + 'token.cancel=()=>{if(e.__lfTracked===token)__lfReject(e)};e.__lfEpoch??=0;e.__lfTracked=token;'
  + 'signal.addEventListener("abort",token.cancel,{once:!0});token.out.once("error",token.cancel);token.out.once("close",token.cancel);'
  + 'token.timer=setTimeout(token.cancel,Math.min(2147483647,Math.max(1,deadline-Date.now())));'
  + 'if(signal.aborted){__lfReject(e);return}C(e,n,token)}';

export function applyRoutingNoticeWriterTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing notice output disabled');
  const start = source.indexOf(MODULE);
  if (start < 0 || source.indexOf(MODULE, start + MODULE.length) >= 0) return result(source, 'FAIL', 'routing notice writer module is unavailable');
  const next = source.indexOf(BOUNDARY, start + MODULE.length);
  const end = next < 0 ? source.length : next;
  const module = source.slice(start, end);
  const anchors: Array<[string, string]> = [
    ['function w(e){return{flush:()=>y(e),restore:()=>_(e),isActive:()=>e.installedWrite!==void 0,queuedBytes:()=>e.queuedBytes}}',
      `${DECLARATION}function w(e){return{flush:()=>y(e),restore:()=>_(e),isActive:()=>e.installedWrite!==void 0,queuedBytes:()=>e.queuedBytes,routingReady:()=>e.__lfReady!==void 0&&e.__lfReady===(e.__lfEpoch??0)&&e.installedWrite!==void 0&&process.stdout===e.__lfOut&&process.stdout.write===e.installedWrite&&process.stdout.isTTY&&!process.stdout.destroyed&&!process.stdout.writableEnded&&!process.stdout.errored,barrier:(a,s,d)=>__lfBarrier(e,a,s,d),writeTracked:(n,s,d,y,f)=>__lfWriteTracked(e,n,s,d,y,f)}}`],
    ['function C(e,n){if(n.length===0)return;',
      'function C(e,n,__lf){if(__lf&&e.__lfTracked!==__lf)return;if(!__lf)__lfReject(e);if(n.length===0){if(__lf)__lfReject(e);return}'],
    ['if(o===n.length)return;e.episode={startedMs:performance.now()',
      'if(o===n.length){if(__lf)__lfFinish(e);return}e.episode={startedMs:performance.now()'],
    ['if(e.dropping){e.episode.droppedBytes+=n.length;return}',
      'if(e.dropping){__lfInvalidate(e);e.episode.droppedBytes+=n.length;return}'],
    ['if(e.queuedBytes+n.length>Q){e.episode.droppedBytes+=e.queuedBytes+n.length,',
      'if(e.queuedBytes+n.length>Q){__lfInvalidate(e);e.episode.droppedBytes+=e.queuedBytes+n.length,'],
    ['if(n&&e.queue.length>1)e.queue=[Buffer.concat(e.queue,e.queuedBytes)];let o=e.queue[0],r=W(e.fd,o);',
      'if(e.__lfTracked&&process.stdout.write!==e.installedWrite)__lfReject(e);if(n&&e.queue.length>1&&!e.__lfTracked)e.queue=[Buffer.concat(e.queue,e.queuedBytes)];let o=e.queue[0],r=W(e.fd,o);'],
    ['if(n=!0,e.queuedBytes-=r,r<o.length)e.queue[0]=o.subarray(r);else e.queue.shift()',
      'if(n=!0,e.queuedBytes-=r,r<o.length)e.queue[0]=o.subarray(r);else{e.queue.shift();if(e.__lfTracked)__lfFinish(e)}'],
    ['function y(e){if(e.timer!==void 0)', 'function y(e){__lfInvalidate(e);if(e.timer!==void 0)'],
    ['function h(e,n){t(`nonBlockingStdout: uninstalling', 'function h(e,n){__lfInvalidate(e);t(`nonBlockingStdout: uninstalling'],
    ['function _(e){if(e.installedWrite===void 0)return;', 'function _(e){__lfInvalidate(e);if(e.installedWrite===void 0)return;'],
  ];
  if (module.includes(MARKER)) return anchors.every(([, replacement]) => module.split(replacement).length === 2)
    ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing notice writer patch is incomplete');
  if (anchors.some(([anchor]) => module.split(anchor).length !== 2)) return result(source, 'FAIL', 'routing notice writer anchors are unavailable');
  let content = module;
  for (const [anchor, replacement] of anchors) content = content.replace(anchor, replacement);
  return result(source.slice(0, start) + content + source.slice(end), 'OK');
}
