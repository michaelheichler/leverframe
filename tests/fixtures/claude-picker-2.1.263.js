function RZ({initial:w,sessionModel:I,onSelect:ne,onSetDefault:me,onCancel:pe,isStandaloneCommand:be,showFastModeNotice:xe,headerText:Ae,options:Oe,skipSettingsWrite:He}){
let[Io,So]=d(null);
void w;void I;void me;void be;void xe;void Ae;void Oe;void He;void Io;void So;
function choose(Ki,Ls){if(Ki===Qw){ne(null,Ls);return}ne(Ki,Ls)}
let ta=r(o,{defaultValue:zt,selectedValue:zt,defaultFocusValue:Qo,options:Fn,onChange:(Ki)=>choose(Ki,Ls),onCancel:pe});return ta}
void RZ;
