export const noticeFrameSource = [
  "\n//#__leverframe_claude_module__:/$bunfs/root/chunk-51640hmv.js\nfunction j$n(r,n){if(r.stdoutDead)return;let o=performance.now(),u=Buffer.by",
  "teLength(n);try{r.stdout.write(n)}catch(s){if(r.tolerateDeadStdout&&(v(s)===\"EIO\"||v(s)===\"EPIPE\")){r.stdoutDead=!0,wAr(r,o,u);return}throw ",
  "s}wAr(r,o,u)}function Nyo(r,n,o=!1,u,s=\"\"){let p=u!==void 0&&u>1?u-1:void 0;if(n.length===0){if(s!==\"\")j$n(r,s);return}let a=!o,d=s+(a?Snn:\"",
  "\");for(let c of n)switch(c.type){case\"stdout\":d+=c.content;break;case\"clear\":if(c.count>0)d+=j7t(c.count);break;case\"clearTerminal\":d+=c.alt",
  "Screen?bxs():Rmt(c.viewportRows);break;case\"cursorHide\":d+=$F;break;case\"cursorShow\":d+=FF;break;case\"cursorMove\":d+=Yne(c.x,p!==void 0?Math",
  ".max(-p,Math.min(p,c.y)):c.y);break;case\"cursorTo\":d+=b8e(c.col);break;case\"carriageReturn\":d+=\"\\r\";break;case\"hyperlink\":d+=kEt(c.uri);brea",
  "k;case\"styleStr\":d+=c.str;break}if(a)d+=Omt;j$n(r,d)}\n\n//#__leverframe_claude_module__:/$bunfs/root/chunk-xsq68wek.js\nfunction Sg(n,u,f){if(",
  "u<0||f<0||u>=n.width||f>=n.height)return;let m=f*n.width+u<<1;return n.charPool.get(n.cells[m])}\nfunction onRender(){let O=this.frontFrame,e",
  "e=O.patches,u=this.options.stdout.columns,f=this.options.stdout.rows,fe=this.terminalImages.drain(),xe=\"\",_=!1;if(fe!==\"\")ee.unshift({type:\"",
  "stdout\",content:fe});let ge=performance.now();this.leftAltScreenSinceFrame=!1,Nyo(this.terminal,ee,this.skipSyncMarkers()||_&&(this.terminal",
  "Images.size>0||fe!==\"\"),f,this.takeKeptForNextFrame());}"
].join('');
