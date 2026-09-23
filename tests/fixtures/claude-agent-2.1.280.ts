export const CLAUDE_AGENT_2_1_280 = [
  'const defaultEffort={kind:"inherit"};',
  'function Za(e,n){let o=e.sessionEffort??defaultEffort;switch(o.kind){case"level":return o.value;case"default":return;case"inherit":return e.effort}}',
  'async function go({agentInput:n,toolUseContext:e,canUseTool:h,assistantMessage:g,onProgress:f}){',
  'let{subagent_type:y,run_in_background:A,name:v,isolation:te}=n,{prompt:ie,description:Ze,cwd:bt}=n,Fe=n.model,B=ie,C=Ze;',
  'let s={agentType:y},tt="opus",_e="default",Y=false;',
  'let Be=Y?"inherit":Fe,Q=tO(Qee(s,tt),tt,Be,_e),Re=zQ(s);e.agentLifecycle.markTypeInvoked(s.agentType);',
  'let G={};let Ao=void 0,Ge={agentDefinition:s,promptMessages:[B],toolUseContext:e,description:C,model:Q,onModelRestricted:(r,w)=>f?.({type:"notification",notification:{key:`agent-model-restricted-${s.agentType}-${aw(r)}`,text:`${s.agentType} agent: ${wy(r,w)}`,priority:"medium",color:"warning",timeoutMs:1e4}})};',
  'let ut=await wn(),ve=$t();G.spawnedSubagent=ve;return Ge}',
].join('');
