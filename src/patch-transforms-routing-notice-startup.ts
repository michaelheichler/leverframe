import type { PatchSiteResult } from './patch-transforms.js';
import { ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from './constants.js';
import { ROUTING_NOTICE_TRUST_SOURCE } from './patch-transforms-routing-notice-trust.js';

const NAME = 'Routing notice output startup';
const MARKER = '/*ccpatch:routing-notice-startup*/';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const MODULE = `${BOUNDARY}/$bunfs/root/chunk-xsq68wek.js\n`;
const DECLARATION = `${MARKER}${ROUTING_NOTICE_TRUST_SOURCE}`
  + 'function __lfStopOutput(e){let ctl=e.__lfOutputAbort,p=e.__lfRoutingNotice;e.__lfOutputAbort=void 0;e.__lfOutputPending=!1;e.__lfRoutingNotice=void 0;ctl?.abort();'
  + 'try{p?.fail()}catch{}}'
  + 'function __lfStartOutput(e,out){if(e.__lfOutputAbort&&!e.__lfOutputAbort.signal.aborted){'
  + 'if(e.__lfOutputPending)return e.__lfOutputPromise;if(!e.isUnmounted&&!e.isExiting&&!e.isHandedOff&&!e.isPaused&&!e._handoffRawMode&&'
  + '!e.isScreenReaderEnabled&&!e.altScreenActive&&e.frameSink===null&&e.options.patchConsole&&out===process.stdout&&'
  + 'e.nonBlockingStdout===e.__lfOwnedWriter&&e.__lfOwnedWriter?.routingReady?.())return e.__lfOutputPromise;__lfStopOutput(e)}'
  + 'let ctl=new AbortController,deadline=Date.now()+15000;e.__lfOutputAbort=ctl;e.__lfOutputPending=!0;'
  + 'e.__lfOutputPromise=(async()=>{try{let original=e.__lfOriginal,writer=e.__lfOwnedWriter;'
  + 'if(writer&&!writer.isActive()){if(out!==process.stdout||out.write!==original)return!1;writer=void 0;e.__lfOwnedWriter=void 0}'
  + 'if(!writer){if(!original)original=await __lfTrustedOriginal(out,ctl.signal,deadline);'
  + 'if(!original||ctl.signal.aborted||e.__lfOutputAbort!==ctl||e.isUnmounted||e.isExiting||e.isHandedOff||'
  + 'e.isPaused||e._handoffRawMode||e.isScreenReaderEnabled||e.altScreenActive||e.frameSink!==null||!e.options.patchConsole||out!==process.stdout||out.write!==original)return!1;'
  + 'writer=ANs(e.handleStdoutBackpressure);if(!writer?.isActive()||typeof writer.barrier!=="function")return!1;'
  + 'e.__lfOriginal=original;e.__lfOwnedWriter=writer;e.nonBlockingStdout=writer}'
  + 'if(e.nonBlockingStdout!==writer||!writer.isActive()||typeof writer.routingReady!=="function")return!1;await writer.barrier(original,ctl.signal,deadline);'
  + 'if(ctl.signal.aborted||e.__lfOutputAbort!==ctl||e.isUnmounted||e.isExiting||e.isHandedOff||e.isPaused||e._handoffRawMode||'
  + 'e.isScreenReaderEnabled||e.altScreenActive||e.frameSink!==null||!e.options.patchConsole||out!==process.stdout||!writer.isActive()||!writer.routingReady())return!1;'
  + 'e.forceRedraw({flushReact:!0});return!0}catch{return!1}})().then(ok=>{if(e.__lfOutputAbort===ctl){e.__lfOutputPending=!1;if(!ok){ctl.abort();if(e.__lfOutputAbort===ctl)e.__lfOutputAbort=void 0}}return ok});'
  + 'return e.__lfOutputPromise}';

export function applyRoutingNoticeStartupTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing notice startup disabled');
  const start = source.indexOf(MODULE);
  if (start < 0 || source.indexOf(MODULE, start + MODULE.length) >= 0) return result(source, 'FAIL', 'routing notice renderer module is unavailable');
  const next = source.indexOf(BOUNDARY, start + MODULE.length);
  const end = next < 0 ? source.length : next;
  const module = source.slice(start, end);
  const original = 'if(this.terminal={stdout:n.stdout,stderr:n.stderr,tolerateDeadStdout:i.CLAUDE_BG_BACKEND==="daemon",stdoutDead:!1},n.stdout===process.stdout&&(jWn()||RNs({envOverride:i.CLAUDE_CODE_NONBLOCKING_STDOUT,isAnt:!1,remoteFlag:()=>v("tengu_event_loop_stall",!1)===!0})))this.nonBlockingStdout=ANs(this.handleStdoutBackpressure);';
  const replacement = 'this.terminal={stdout:n.stdout,stderr:n.stderr,tolerateDeadStdout:i.CLAUDE_BG_BACKEND==="daemon",stdoutDead:!1};'
    + `if(process.env[${JSON.stringify(ROUTING_NOTICE_ACTIVE_ENV)}]===${JSON.stringify(ROUTING_ACTIVE_VALUE)}){this.__lfEnsureOutput=()=>__lfStartOutput(this,n.stdout);this.__lfEnsureOutput()}`
    + 'else if(n.stdout===process.stdout&&(jWn()||RNs({envOverride:i.CLAUDE_CODE_NONBLOCKING_STDOUT,isAnt:!1,remoteFlag:()=>v("tengu_event_loop_stall",!1)===!0})))this.nonBlockingStdout=ANs(this.handleStdoutBackpressure);';
  const anchors: Array<[string, string]> = [
    ['class s7e{', `${DECLARATION}class s7e{`],
    [original, replacement],
    ['pause(){_t.flushSyncFromReconciler()', 'pause(){__lfStopOutput(this);_t.flushSyncFromReconciler()'],
    ['handoffAltScreen(){this.isPaused=!0', 'handoffAltScreen(){__lfStopOutput(this);this.isPaused=!0'],
    ['handoffRawMode(){this._handoffRawMode=!0}', 'handoffRawMode(){__lfStopOutput(this);this._handoffRawMode=!0}'],
    ['detachForShutdown(){if(this.nonBlockingStdout?.flush()', 'detachForShutdown(){__lfStopOutput(this);if(this.nonBlockingStdout?.flush()'],
    ['unmount(n){if(this.isUnmounted)return;', 'unmount(n){__lfStopOutput(this);if(this.isUnmounted)return;'],
  ];
  if (module.includes(MARKER)) return anchors.every(([, value]) => module.split(value).length === 2)
    ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing notice startup patch is incomplete');
  if (anchors.some(([anchor]) => module.split(anchor).length !== 2)) return result(source, 'FAIL', 'routing notice startup anchors are unavailable');
  let content = module;
  for (const [anchor, value] of anchors) content = content.replace(anchor, value);
  return result(source.slice(0, start) + content + source.slice(end), 'OK');
}
