import { z } from 'zod';
import type { RoutingPromptPolicy } from '../../src/model-routing.js';
import { applyModelRoutingTransform } from '../../src/patch-transforms-model-routing.js';
import { CLAUDE_AGENT_2_1_314_SIDECAR_SOURCE } from './claude-agent-2.1.314-sidecar.js';

export const CLAUDE_2_1_314_SOURCE_SHA256 = '0ae6fe5cd0cc3054d34720fb06404e95bc14f4b3a8cf546cfb80045b0d767994';
export const CLAUDE_2_1_314_ROUTING_OFFSETS = { launch: 18_262_169, resume: 18_213_331 };
export const CLAUDE_AGENT_2_1_314_ROUTING_SIDECAR_SOURCE = CLAUDE_AGENT_2_1_314_SIDECAR_SOURCE;

const boundary = '\n//#__leverframe_claude_module__:';
const launchImport = 'import{et,Jut,_e,Kve,X}from"/$bunfs/root/chunk-ne3vazsy.js";';
const resumeImport = 'import{et,ve,Sp,_e,Kve,X,wde,Rre,I_}from"/$bunfs/root/chunk-ne3vazsy.js";';

export const CLAUDE_AGENT_2_1_314_ROUTING_SOURCE = [
  boundary + '/$bunfs/root/chunk-3pr91mb5.js\n' + launchImport,
  'async function runLaunch(e){let q="Review the accepted task",h={agentType:"reviewer",model:"native-child-model"},ve=[{role:"user",content:q}],Ze="native-child-model",x=e.isFork===true,ke=e.isRemote===true,vt="parent-model",Ne="selection",Dt="high",wn=false,he=void 0;'
    + 'let $e=x?"inherit":Ze,oe=jG(iAe(h,vt),vt,$e,Ne);let Pt=await ffn([h],oe,he?.totalTokensBudget);let ye=lS(),We=e.agentId;'
    + 'function AVe(){return false}function Nce(){return{onToolPool:void 0,reviewTools:[]}}'
    + 'let _n=wn&&AVe(),{onToolPool:go,reviewTools:Nt}=Nce(e.options.tools),ut={agentDefinition:h,promptMessages:ve,turnPrompt:q,toolUseContext:e,canUseTool:void 0,name:"Review",isAsync:false,handbackOptIn:true,handbackTool:void 0,persistedToolResultFiles:void 0,querySource:void 0,spawnedBySkill:void 0,spawnedByForkedSkill:void 0,model:$e,effort:Dt,};ut.systemPromptModel=oe;ut.noticeModel=ut.model;ut.launchId=ye;return ut}'
    + 'async function restoreAgentCall(e){if(Kt!==void 0){let r=await xn(Kt,e);return r}}',
  boundary + '/$bunfs/root/chunk-pwf6g3a4.js\n' + resumeImport,
  'async function runResume(r,e){let P={agentType:"reviewer"},s="Resume the accepted task",h={model:"native-resume-model"},C=false,sn="medium",Be="resume";'
    + 'function fc(){return"parent-resume-model"}function Nce(){return{onToolPool:void 0,reviewTools:[]}}'
    + 'let dn=fc(r),Ye=jG(iAe(P,dn),dn,h?.isObserver?void 0:C?"inherit":h?.model,Be),yt=Ye;let Pt=await ffn([P],Ye,void 0);'
    + 'let {onToolPool:mr,reviewTools:An}=Nce(r.options.tools),Sn={agentDefinition:P,promptMessages:[{role:"user",content:s}],toolUseContext:r,model:h?.isObserver?void 0:C?"inherit":h?.model,effort:sn,};return Sn}',
  boundary + '/$bunfs/root/fixture-tail.js\n',
].join('\n');

export const CLAUDE_AGENT_2_1_314_ROUTING_DECISION_OFFSETS = {
  resolver: 18_050_437,
  context: 18_065_595,
  outboundModel: 12_570_271,
};

export const ROUTING_TEST_PROMPT_POLICY: RoutingPromptPolicy = {
  version: 1,
  defaultCategory: 'review',
  agentCategories: { reviewer: 'review' },
  categoryInstructions: { review: 'Check the requested behavior and preserve its constraints.' },
};

export function claudeAgentRoutingHandoffSource(): string {
  const schema = 'Go=f(()=>u({description:o().describe(lmi),prompt:o().describe(ami),subagent_type:o().optional(),model:o().optional()}));'
    + 'let Ho=Go.extend({launchMode:o().optional()}),Qn=Go.extend({forkMode:o().optional()});'
    + 'function lwo(value,fork){return fork?Qn.parse(value):Ho.parse(value)}';
  const oldInput = 'async function runLaunch(e){let q="Review the accepted task",h={agentType:"reviewer",model:"native-child-model"},ve=[{role:"user",content:q}],Ze="native-child-model",x=e.isFork===true,ke=e.isRemote===true,vt="parent-model",Ne="selection",Dt="high",wn=false,he=void 0;';
  const newInput = 'async function runLaunch(e){let n=lwo(e.agentInput,e.isFork===true),q=n.prompt,h={agentType:n.subagent_type,model:"native-child-model"},it=void 0,ve=[],Ze="native-child-model",x=e.isFork===true,ke=e.isRemote===true,Ne="selection",Dt="high",wn=false,he=void 0,no=e.teammate===true,L=true,R={},fe={},we=false,j="",ie="";';
  const oldResume = 'async function runResume(r,e){let P={agentType:"reviewer"},s="Resume the accepted task",h={model:"native-resume-model"},C=false,sn="medium",Be="resume";';
  const newResume = 'async function runResume(r,e){let P={agentType:"reviewer"},s="Resume the accepted task",h={model:"native-resume-model"},C=false,sn="medium",Be="resume",E=r.E===true,Q=r.promptMessages??[],bn=r.followupMessages??[],mn=r.generatedMessages??[],Xe={role:"user",content:"The current follow-up"};';
  const hooks = 'if(no&&L&&!x&&!oX(R,fe)&&!we&&!ie&&!UH()){spawnTeammate(e);return{teammate:true}}'
    + 'let vt=fc(e),De=await XAo({tool_use_id:"fixture-tool-use",prompt:q,description:n.description});'
    + 'let cn=()=>Gt(n,{prompt:q}),io=cn(),{spawn:Ae}=De,rt=De.agent!==h,It=rt||Ae.background!==U;'
    + 'if(h=De.agent,q=Ae.prompt,j=Ae.description.replace(/\\s+/g," ").trim(),ie=Ae.cwd,ie!==_t)await Hn(ie,"a hook");'
    + 'let Et=await Bn({tool:Rrn,raised:io,rewritten:cn(),context:e});'
    + 'it=fEi(e.messages,gqs(e)),ve=[...it.copies,Oe({content:q})];';
  const base = [CLAUDE_AGENT_2_1_314_ROUTING_SOURCE, CLAUDE_AGENT_2_1_314_ROUTING_DECISION_SOURCE,
    CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, CLAUDE_AGENT_2_1_314_ROUTING_SIDECAR_SOURCE].join('\n');
  const withSchema = base.replace('async function runLaunch(e){', `${schema}async function runLaunch(e){`);
  const withInput = withSchema.replace(oldInput, newInput);
  const withHooks = withInput.replace('let $e=x?"inherit":Ze,oe=jG(iAe(h,vt),vt,$e,Ne);', `${hooks}let $e=x?"inherit":Ze,oe=jG(iAe(h,vt),vt,$e,Ne);`);
  const withResume = withHooks.replace(oldResume, newResume)
    .replace('promptMessages:[{role:"user",content:s}]', 'promptMessages:E?Q:[...Q,...bn,...mn,Xe]');
  return withResume.replace('function buildRequest(Z,R_){let cS=Z.max_tokens,Jm=Z.thinking,dE=Z.system,ad=Z.tools??[];',
    'function buildRequest(Z,R_){let ft=[],dE=Die(),YF=ft.length>0;let cS=Z.max_tokens,Jm=Z.thinking,ad=Z.tools??[];')
    .replace('agentContext:Z.agentContext,tools:$u.tools', 'agentContext:Z.agentContext,system:$u.system,tools:$u.tools');
}

export function executableRoutingHandoffSource(source = claudeAgentRoutingHandoffSource()): string {
  const transformed = applyModelRoutingTransform(source, { enabled: true, promptPolicy: ROUTING_TEST_PROMPT_POLICY });
  if (transformed.results.some(result => result.status === 'FAIL')) {
    throw new Error(`Routing handoff fixture is unsupported: ${transformed.results.filter(result => result.status === 'FAIL').map(result => result.extra).join('; ')}`);
  }
  return transformed.content.replace(/import\{[^}]+\}from"[^"]+";/g, '');
}

export function routingHandoffSchemaGlobals() {
  return { f: (thunk: () => unknown) => thunk(), u: z.object, o: () => z.string(), T: z.array, C: z.literal,
    lmi: 'Agent description', ami: 'Agent task' };
}

const decisionImport = 'import{mde,ZC,KMt,XIi,FS,Sre,$S,z,et,ve,mo,Sp,_v,_e,ept,Zk,Kve,mL,X,lpt,On,Ns}from"/$bunfs/root/chunk-ne3vazsy.js";';

export const CLAUDE_AGENT_2_1_314_ROUTING_DECISION_SOURCE = [
  boundary + '/$bunfs/root/chunk-430w8txz.js\n' + decisionImport,
  'async function* tP({agentDefinition:e,promptMessages:n,toolUseContext:r,canUseTool:A,isAsync:h,override:w,model:Z,effort:Q,session:xe,spawnMode:Ne}){'
    + 'let dt="parent-model",Le="permission",lo=0,Tt=false,He=Ne==="resume",we=r.spawnedByWorkflowRunId;'
    + 'let Xe=EKs(iAe(e,dt),dt,Z,Le,lo,Tt?void 0:He?"resume":"spawn",{inWorkflowRun:we!==void 0||!He&&!Tt&&r.spawnedByWorkflowRunId!==void 0}),Ot=Xe;'
    + 'let tt=FWr(r);if(w?.onRetryStatus)tt.onRetryStatus=w.onRetryStatus;'
    + 'yield {model:Ot,effort:Q,contextWindow:r.contextWindow,agentContext:tt.agentContext}}'
    + 'async function runAndSend(input){let resolved;for await(const result of tP(input))resolved=result;'
    + 'return send(buildRequest({model:resolved.model,effort:resolved.effort,contextWindow:resolved.contextWindow,agentContext:resolved.agentContext,max_tokens:input.max_tokens??100},null))}',
  boundary + '/$bunfs/root/chunk-sq7yspzm.js\n',
  'function buildRequest(Z,R_){let cS=Z.max_tokens,Jm=Z.thinking,dE=Z.system,ad=Z.tools??[];ad=s8t(ad,gt);let $u=Z.inherited!==void 0?Ih.shapeInheritedFields(Z.inherited,{system:dE,tools:ad}):{system:dE,tools:ad},H6=dE,VA=ad,B6=$u.system!==dE,Yc={model:LT(Z.model),messages:R_!==null,metadata:a6e({agentContext:Z.agentContext}),max_tokens:cS,thinking:Jm,effort:Z.effort,contextWindow:Z.contextWindow,agentContext:Z.agentContext,tools:$u.tools};return Yc}'
    + 'async function* C1(e,s,n,h){let w=e.name,L=Ub(s.options.tools,w,s.options.toolAliases);return}',
  boundary + '/$bunfs/root/chunk-m76gkyft.js\n',
  'class Js{addTool(e,n){let r=Ub(this.toolDefinitions,e.name,this.toolUseContext.options.toolAliases);return r}}',
  boundary + '/$bunfs/root/fixture-routing-tail.js\n',
].join('\n');

export const CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE = [
  boundary + '/$bunfs/root/chunk-bqbyxpv1.js\n',
  'function ro(e,n){try{if(gOe(e))return!1}catch{return!1}if(n?.allowlist===void 0){try{if(e3())return!1}catch{return!1}if(!n?.skipEntitlementDenyOverlay&&uV(e,pV()))return!1}let r=lr()||{},s=n?.allowlist??r.availableModels;if(!s)return!0;if(s.length===0)return!1;let h;try{h=wK()}catch{return!1}let y=(h?s.filter((x)=>Qdt(x).kind!=="ignored"):s).map((x)=>Dt(x.trim().toLowerCase()));if(y.length===0)return!1;let b=Dt(e.trim().toLowerCase());if(h){let x=Pw(b,n?.envFreeAliasResolution);if(x!==null&&(Pw(x,n?.envFreeAliasResolution)!==null||!ro(x,n)))return!1}if(y.includes(b)&&!v_(b)){if(n?.envFreeAliasResolution||!dr(b)||beo(b,n))return!0}let w;if(n?.overridesMap!==void 0)w=Rw(e,n.overridesMap);else if(n?.ignoreModelOverrides)w=e;else{let x;try{x=Se("policySettings")}catch{return!1}w=x?.availableModels!==void 0?Rw(e,x.modelOverrides??Cge()??{}):HTn(e)}let A=Dt(w.trim().toLowerCase());if(y.includes(A)){if(!v_(A)||!hso(A,y)){if(n?.envFreeAliasResolution||A!==b||!dr(A)||beo(A,n))return!0}}for(let x of y)if(v_(x)&&!hso(x,y)&&yK(A,x,n?.envFreeAliasResolution))return!0;if(dr(A)){let x=Dt(Ut(A).toLowerCase());if(y.includes(x))return!0}for(let x of y)if(!v_(x)&&HS(x)){let P=tos(x);if(P!==null&&Dt(P)===A)return!0}for(let x of y)if(!v_(x)&&!HS(x)&&bK(A,x)&&(!h||kK(A,x,n?.envFreeAliasResolution)))return!0;return!1}',
  'function Ut(e){return zP(hV(sG(e)))}',
  'function LT(e){let n=jn(e),r=n.toLowerCase();if(!Object.hasOwn(D0,r))return cG(n)??n;let s=D0[r];if(s===void 0)return n;let h=Ck({id:r,raw:Mme()[s],overrideKey:r});if(h===void 0)return n;let y=Te();if(h.overridden||y!=="foundry"&&Io[s][y]!==null)return jn(h.mapped);return n}',
  'function yUe(...e){return Xy(ln(),e)}',
  'function dn(...e){return yUe(...e)?.runtime}',
  'function DZr(...e){return dn(...e)?.effort_levels?.map((n)=>n.trim().toLowerCase())}',
  boundary + '/$bunfs/root/chunk-a0eq9prc.js\n',
  'function iQo(e,n){let{cli:r,env:s,settings:d,agentFrontmatter:u}=e,c=r.model==="default"?Td():r.model,E=c,m=null;if(c)m=r.model==="default"?"cli_default":"cli";let S=u?.model,h;if(!c&&S&&S!=="inherit")h=S,c=Ut(S),E=S,m=u?.modelSource==="routine"?"routine_frontmatter":"agent_frontmatter";let y=!1,x,p=c;if(p===void 0){if(s.ANTHROPIC_MODEL)p=s.ANTHROPIC_MODEL,m="env";else if(p=Le(d.model||void 0,r.isNonInteractiveSession===!0,n)||void 0,p!==void 0)m=be(nO("model"));E=p}let _;if(p&&!ro(p)){let C=h!==void 0&&!y?h:p,A=y?null:Ak(C);if(A!==null){if(_=C,p=A,c!==void 0)c=A}else{if(!(C.trim().toLowerCase()==="default"||eos(C))&&!y)_=C;p=void 0,E=void 0,m=null,c=void 0}}let k;if(p&&R9t(p,Me(m)?"persisted":"explicit"))k=p,p=void 0,E=void 0,m=null,c=void 0;let P=p||null,L=Ut(P??Td());return{effectiveModel:c,initialMainLoopModel:P,resolvedInitialModel:L,rawModelRequest:E||null,restrictedModel:_,unservedModelSpelling:k,settingLayer:m,modelWithoutStartupOverride:x}}',
  'function nkn(e){let n=le(e),r=null,s=Te();if(s==="firstParty"||s==="gateway"){let u=Qe(DD(e.trim().toLowerCase()),{identity:!0}),c=ROe().find((E)=>Qe(DD(E.apiName.trim().toLowerCase()),{identity:!0})===u)?.maxEffortLevel;r=c!=null&&lE(c)?c:null}let d=r===null?n:n===null?r:b(n)<b(r)?n:r;return d==="max"?null:d}',
  boundary + '/$bunfs/root/chunk-z2g9tcvz.js\n',
  'function Qb(e){let n=Dt(e.trim().toLowerCase());if(HD(n))return!1;if(Lu(e))return!1;if(n==="best")return!1;return qK(e)}',
  'function _p({userSpecifiedModel:e,permissionMode:n,thinkingConfig:r}){let s=e&&(Qb(e)||ro(e))?Ut(e):ot(),h=fy({permissionMode:n,mainLoopModel:s});return{mainLoopModel:s,runtimeModel:h,thinkingConfig:r?r:K7()!==!1?{type:"adaptive"}:{type:"disabled"}}}',
  'async function pS({session:e,tools:n,runtimeModel:r,customSystemPrompt:s,appendSystemPrompt:h,appendSystemPromptHead:y,excludeDynamicSections:w,cacheBreakerPhrase:P,mcpClients:b,storageV5:A,credentials:L}){fh("before_getSystemPrompt");return{runtimeModel:r}}',
  boundary + '/$bunfs/root/fixture-main-router-tail.js\n',
].join('\n');

export const CLAUDE_2_1_314_MAIN_ROUTER_OFFSETS = {
  catalogLookup: 3_377_601,
  modelAllowlist: 3_650_072,
  modelNormalize: 3_713_023,
  requestIdentity: 3_715_362,
  modelChoice: 4_857_360,
  modelEffort: 4_930_368,
  mainModelResolve: 38_880_087,
};
