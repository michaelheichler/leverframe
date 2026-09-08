let Go=V(()=>{let Ki=[];for(let[As,Ls,va]of[[fo.current,fo.value,"Current model"],[fo.sessionOverride===null?null:w,w===null?Qw:umt(Ct,w)??w,"Base model"]])if(As!==null&&!Ct.some((Bi)=>Bi.value===Ls)&&!Ki.some((Bi)=>Bi.value===As)&&Rr(As))Ki.push({value:As,label:WC(As),description:va});if(Ki.length===0)return Ct;let qi=Ct.findIndex((As)=>As.disabled===!0);if(qi===-1)return[...Ct,...Ki];return[...Ct.slice(0,qi),...Ki,...Ct.slice(qi)]},[Ct,fo,w]);
let Fn=Go;
let Qo=V(()=>Fn.some((Ki)=>Ki.value===fo.value)?fo.value:Fn[0]?.value??void 0,[Fn,fo.value]);
function RZ({initial:w,sessionModel:I,onSelect:ne,onSetDefault:me,onCancel:pe,isStandaloneCommand:be,showFastModeNotice:xe,headerText:Ae,options:Oe,skipSettingsWrite:He}){
let[Io,So]=d(null);
void w;void I;void me;void be;void xe;void Ae;void Oe;void He;void Io;void So;
function choose(Ki,Ls){if(Ki===Qw){ne(null,Ls);return}ne(Ki,Ls)}
let ta=r(o,{defaultValue:zt,selectedValue:zt,defaultFocusValue:Qo,options:Fn,onChange:(Ki)=>choose(Ki,Ls),onCancel:pe});return ta}
void RZ;
