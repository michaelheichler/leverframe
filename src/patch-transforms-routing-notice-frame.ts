import type { PatchSiteResult } from './patch-transforms.js';

const NAME = 'Routing notice visible frame';
const MARKER = '/*ccpatch:routing-notice-frame*/';
const BOUNDARY = '\n//#__leverframe_claude_module__:';
const OUTPUT_MODULE = `${BOUNDARY}/$bunfs/root/chunk-51640hmv.js\n`;
const RENDER_MODULE = `${BOUNDARY}/$bunfs/root/chunk-xsq68wek.js\n`;
const DECLARATION = `${MARKER}function __lfVisibleNotice(frame,width,height,text){`
  + 'if(typeof text!=="string"||!text.length||text.length>4096||!Number.isSafeInteger(width)||width<1||'
  + '!Number.isSafeInteger(height)||height<2||!frame?.screen||!frame.viewport||'
  + 'frame.screen.width!==width||frame.viewport.width!==width||frame.viewport.height!==height||'
  + '!Number.isSafeInteger(frame.screen.height)||frame.screen.height<1)return!1;let rows=text.split("\\n");'
  + 'if(rows.length>16||rows.some(row=>!row.length||row.length>width||!/^[\\x20-\\x7e]+$/.test(row)))return!1;'
  + 'let top=Math.max(0,frame.screen.height-height+1),matches=0;'
  + 'for(let y=top;y+rows.length<=frame.screen.height;y++){let ok=!0;'
  + 'for(let r=0;r<rows.length&&ok;r++){let found=0;for(let x=0;x+rows[r].length<=width;x++){'
  + 'let same=!0;for(let i=0;i<rows[r].length;i++)if(Sg(frame.screen,x+i,y+r)!==rows[r][i]){same=!1;break}'
  + 'if(same)found++}if(found!==1)ok=!1}if(ok&&++matches>1)return!1}return matches===1}'
  + 'function __lfFrameWriter(renderer,frame,patches,width,height){let p=renderer.__lfRoutingNotice;'
  + 'if(!p||p.signal?.aborted||Date.now()>=p.deadline||renderer.isUnmounted||renderer.isHandedOff||renderer.isScreenReaderEnabled||'
  + 'renderer.altScreenActive||renderer.frameSink!==null||renderer.terminal?.stdoutDead||renderer.terminal?.stdout!==process.stdout||renderer.options?.patchConsole!==!0||renderer.options.stdout!==process.stdout||'
  + 'process.stdout.columns!==width||process.stdout.rows!==height||'
  + '!renderer.nonBlockingStdout?.isActive()||renderer.terminalImages?.size!==0||'
  + '!patches.some(q=>q.type==="clearTerminal"&&!q.altScreen)||!__lfVisibleNotice(frame,width,height,p.text))return;'
  + 'const fail=()=>{if(renderer.__lfRoutingNotice!==p)return;renderer.__lfRoutingNotice=void 0;'
  + 'try{p.fail()}finally{queueMicrotask(()=>{if(!renderer.isUnmounted&&!renderer.isHandedOff)renderer.forceRedraw({flushReact:!0})})}};'
  + 'return data=>renderer.nonBlockingStdout.writeTracked(Yle+data,p.signal,p.deadline,()=>{'
  + 'let size=renderer.stdoutSize();if(renderer.__lfRoutingNotice!==p||renderer.frontFrame!==frame||renderer.isUnmounted||'
  + 'renderer.isHandedOff||renderer.isScreenReaderEnabled||renderer.altScreenActive||renderer.frameSink!==null||renderer.terminal?.stdoutDead||'
  + 'renderer.terminal?.stdout!==process.stdout||renderer.options?.patchConsole!==!0||renderer.terminalImages?.size!==0||'
  + 'renderer.options.stdout!==process.stdout||process.stdout.columns!==width||process.stdout.rows!==height||'
  + 'size.columns!==width||size.rows!==height||!__lfVisibleNotice(frame,width,height,p.text)){fail();return}'
  + 'p.complete();if(renderer.__lfRoutingNotice===p)renderer.__lfRoutingNotice=void 0},fail)}';

export function applyRoutingNoticeFrameTransform(source: string, options: { enabled: boolean }) {
  const result = (content: string, status: PatchSiteResult['status'], extra?: string) =>
    ({ content, results: [{ name: NAME, status, ...(extra ? { extra } : {}) }] });
  if (!options.enabled) return result(source, 'SKIP', 'routing notice frame disabled');
  const modules: Array<{ marker: string; replacements: Array<[string, string]> }> = [
    { marker: OUTPUT_MODULE, replacements: [
      ['function j$n(r,n){if(r.stdoutDead)return;let o=performance.now(),u=Buffer.byteLength(n);try{r.stdout.write(n)}',
        'function j$n(r,n,__lfWrite){if(r.stdoutDead)return;let o=performance.now(),u=Buffer.byteLength(n);try{if(__lfWrite)__lfWrite(n);else r.stdout.write(n)}'],
      ['function Nyo(r,n,o=!1,u,s=""){', 'function Nyo(r,n,o=!1,u,s="",__lfWrite){'],
      ['if(s!=="")j$n(r,s);return}', 'if(s!=="")j$n(r,s,__lfWrite);return}'],
      ['if(a)d+=Omt;j$n(r,d)}', 'if(a)d+=Omt;j$n(r,d,__lfWrite)}'],
    ] },
    { marker: RENDER_MODULE, replacements: [
      [RENDER_MODULE, RENDER_MODULE + DECLARATION],
      ['this.leftAltScreenSinceFrame=!1,Nyo(this.terminal,ee,this.skipSyncMarkers()||_&&(this.terminalImages.size>0||fe!==""),f,this.takeKeptForNextFrame());',
        'let __lfKept;this.leftAltScreenSinceFrame=!1,Nyo(this.terminal,ee,this.skipSyncMarkers()||_&&(this.terminalImages.size>0||fe!==""),f,__lfKept=this.takeKeptForNextFrame(),fe===""&&xe===""&&__lfKept===""?__lfFrameWriter(this,O,ee,u,f):void 0);'],
    ] },
  ];
  const slices = modules.map(({ marker, replacements }) => {
    const start = source.indexOf(marker);
    if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) return undefined;
    const next = source.indexOf(BOUNDARY, start + marker.length);
    const end = next < 0 ? source.length : next;
    return { start, end, content: source.slice(start, end), replacements };
  });
  if (slices.some(slice => !slice)) return result(source, 'FAIL', 'routing notice renderer module is unavailable');
  const present = slices.map(slice => slice!.replacements.some(([, replacement]) => slice!.content.includes(replacement)));
  if (present.some(Boolean)) return slices.every(slice => slice!.replacements.every(([, replacement]) => slice!.content.split(replacement).length === 2))
    ? result(source, 'SKIP', 'already integrated') : result(source, 'FAIL', 'routing notice renderer patch is incomplete');
  if (slices.some(slice => slice!.replacements.some(([anchor]) => slice!.content.split(anchor).length !== 2))) {
    return result(source, 'FAIL', 'routing notice renderer anchors are unavailable');
  }
  let content = source;
  for (const slice of slices.sort((a, b) => b!.start - a!.start)) {
    let module = slice!.content;
    for (const [anchor, replacement] of slice!.replacements) module = module.replace(anchor, replacement);
    content = content.slice(0, slice!.start) + module + content.slice(slice!.end);
  }
  return result(content, 'OK');
}
