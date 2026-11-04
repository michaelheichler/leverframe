export const noticeStartupSource = [
  '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-xsq68wek.js\n',
  'class s7e{',
  'constructor(n){this.options=n;this.isUnmounted=!1;this.isExiting=!1;this.isHandedOff=!1;this.isPaused=!1;'
    + 'this._handoffRawMode=!1;this.isScreenReaderEnabled=!1;this.altScreenActive=!1;this.frameSink=null;'
    + 'this.nonBlockingStdout=null;this.handleStdoutBackpressure=()=>{};this.onRender=()=>{};'
    + 'this.endPointerCapture=()=>{};this.tellClickedNowhere=()=>{};this.modes={isSuspended:!1,reset:()=>{}};'
    + 'this.displayCursor=null;this.renderCalled=!1;this.rootNode={};this.scheduleRender={cancel:()=>{}};'
    + 'this.unsubscribeTTYHandlers=()=>{};this.unsubscribeExit=()=>{};this.restoreConsolePatches=()=>{};'
    + 'this.cancelFinePointerSettle=()=>{};this.writeKeptForNextFrame=()=>{};this.drainStdin=()=>{};'
    + 'this.writeBeforeExit=()=>{};this.resolveExitPromise=()=>{};this.rejectExitPromise=()=>{};'
    + 'this.srStartupQuietTimer=null;this.srPreParkTimer=null;this.srAnnouncementHoldTimer=null;'
    + 'this.patchConsole=()=>{};this.patchStderr=()=>{};this.forceRedraw=__lfForceRedraw;'
    + 'if(this.terminal={stdout:n.stdout,stderr:n.stderr,tolerateDeadStdout:i.CLAUDE_BG_BACKEND==="daemon",stdoutDead:!1},'
    + 'n.stdout===process.stdout&&(jWn()||RNs({envOverride:i.CLAUDE_CODE_NONBLOCKING_STDOUT,isAnt:!1,'
    + 'remoteFlag:()=>v("tengu_event_loop_stall",!1)===!0})))this.nonBlockingStdout=ANs(this.handleStdoutBackpressure);}',
  'pause(){_t.flushSyncFromReconciler(),this.onRender(),this.isPaused=!0}',
  'resume(){this.isPaused=!1,this.onRender()}',
  'handoffAltScreen(){this.isPaused=!0,this.altScreenActive=!1,this.endPointerCapture(),this.tellClickedNowhere(),'
    + 'this.modes.reset("altScreen"),this.modes.reset("surface")}',
  'handoffRawMode(){this._handoffRawMode=!0}',
  'detachForShutdown(){if(this.nonBlockingStdout?.flush(),!this.isUnmounted&&!this.altScreenActive&&'
    + 'this.displayCursor!==null&&this.options.stdout.isTTY){let u=this.frontFrame.cursor.x-this.displayCursor.x,'
    + 'f=this.frontFrame.cursor.y-this.displayCursor.y;if(u!==0||f!==0)Pv(1,Yne(u,f));this.displayCursor=null}'
    + 'this.isUnmounted=!0,this.scheduleRender.cancel?.(),this.unsubscribeTTYHandlers?.();let n=this.options.stdin;'
    + 'if(this.drainStdin(),n.isTTY&&n.isRaw)Cv(n,!1);for(let u of new Set([n,process.stdin]))'
    + 'u.removeAllListeners("readable"),u.removeAllListeners("data"),u.removeAllListeners("keypress"),'
    + 'u.pause(),u.unref?.()}',
  'unmount(n){if(this.isUnmounted)return;this.isUnmounted=!0}',
  '}',
].join('\n');
