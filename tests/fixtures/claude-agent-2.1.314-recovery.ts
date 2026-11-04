import {
  CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE,
  CLAUDE_AGENT_2_1_314_ROUTING_SIDECAR_SOURCE,
} from './claude-agent-2.1.314-routing.js';

const boundary = '\n//#__leverframe_claude_module__:';
const resumeImport = 'import{et,ve,Sp,_e,Kve,X,wde,Rre,I_}from"/$bunfs/root/chunk-ne3vazsy.js";';

const recoveryResumeModule = `${boundary}/$bunfs/root/chunk-pwf6g3a4.js
${resumeImport}
async function jr({agentId:e,prompt:s,promptOrigin:y,promptToolsUsed:A,promptNoticeLengths:S,promptNoticeOwn:M,promptNoticeRunIds:N,promptIsMeta:O,continueInterruptedTurn:E,waitingToolUse:F,resultsOnly:G,toolUseContext:r,liveTranscript:re,canUseTool:x,invokingRequestId:Ee,parentPromptId:Ne,userInitiated:z,suppressOwnerNotification:Pe,workerPermissionMode:Ce,onDeliveryCommitted:ie,isWebFetchLaunch:De},j,Le){
let Ht,xt,Ut,K,Vt,zt,Jn,h,W=void 0,Zo=void 0,Q=r.promptMessages??[],bn=r.followupMessages??[],mn=r.generatedMessages??[],Xe={role:"user",content:"Current recovery follow-up"};
Ht=z||y?.kind==="observer-activity"?void 0:Zo,xt=nE(Or(e),r.storageV5,Ht),Ut=async()=>(await jt(op(),Wr,"agent resume: transcript flush wait").catch(()=>{}),xse(Or(e),r.storageV5,{signal:r.abortController.signal})),K=gLe(),Vt=X()&&!vn(W)&&K===void 0,zt=X()?xt.then((n)=>n===null||Vt?null:Ut()):Ut(),[Jn,h]=await Promise.all([zt,xt.then((n)=>n===null&&!X()&&ptt()?zt.then(()=>nE(Or(e),r.storageV5,Ht)):n)]);
let C=globalThis.isFork===true,L=void 0,ir=h?.effort!==void 0&&lE(h.effort)?h.effort:void 0,sn=h?.isObserver||C?void 0:ir,an=L?.effort??sn,P=an!==void 0?{...h,effort:an}:h,Ue=r,Be="default";
let dn=fc(r),Ye=jG(iAe(P,dn),dn,h?.isObserver?void 0:C?"inherit":h?.model,Be),yt=UZe(Q,Ue.options)?.systemPrompt,ke=h?.isObserver||L!==void 0?void 0:RMr({agentDefinition:P,isFork:C,model:Ye,effortState:Ue.getAppState(),inheritedLayers:Ue.permissionLayers,recordedBudgetText:C?xn(Q):yt});
P=ke?.agentDefinition??P;
let Sn={agentDefinition:P,promptMessages:E?Q:[...Q,...bn,...mn,Xe],toolUseContext:Ue,model:h?.isObserver?void 0:C?"inherit":h?.model,effort:sn,override:{},session:r.session,spawnMode:"resume",callerDeliveredReport:true},kt=r.session,Mt={agentType:"subagent",agentId:e,invocationKind:"resume"},Y={agentId:e,abortController:new AbortController()},ee=false,gt=false,En={agentContext:Mt};
return soe({taskId:Y.agentId,abortController:Y.abortController,makeStream:(n,w,b)=>tP({...Sn,session:kt,override:{...Sn.override,agentId:Or(Y.agentId),agentContext:Mt,abortController:Y.abortController},onCacheSafeParams:n,onQueryProgress:w,onStreamTokenEstimate:b,...K!==void 0&&ee&&!gt&&{canShowPermissionPrompts:!1}}),metadata:{...En,agentContext:Mt}})
}`;

const recoveryRunnerModule = `${boundary}/$bunfs/root/chunk-430w8txz.js
async function* tP({agentDefinition:e,promptMessages:n,toolUseContext:r,override:w,model:Z,effort:Q,maxOutputTokens:cS=globalThis.outputTokens??900,session:xe,spawnMode:Ne,callerDeliveredReport:We}){let At=xe??r.session,He=w?.agentContext?.agentType==="subagent"&&w.agentContext.invocationKind==="resume";globalThis.recoveryCaptures.promptMessages.push(n);let dt="parent-model",Le="permission",lo=0,Tt=false,we=r.spawnedByWorkflowRunId;let Xe=EKs(iAe(e,dt),dt,Z,Le,lo,Tt?void 0:He?"resume":"spawn",{inWorkflowRun:we!==void 0||!He&&!Tt&&r.spawnedByWorkflowRunId!==void 0}),Ot=Xe;globalThis.runnerModels.push(Ot);let tt=FWr(r);if(w?.onRetryStatus)tt.onRetryStatus=w.onRetryStatus;try{globalThis.iteratorBefore.push(yUe(Z));if(globalThis.nestedRecovery==="unbound")await tP({toolUseContext:r,model:Z,session:xe}).next();if(globalThis.nestedRecovery==="mismatched")await tP({toolUseContext:r,model:Z,session:xe,routingBinding:"forged-binding"}).next();if(globalThis.nestedRecovery==="agent")await Xo({agentInput:{subagent_type:"reviewer"},toolUseContext:r});if(globalThis.nestedRecovery==="jr")await jr({agentId:"nested-recovery-child",toolUseContext:r});globalThis.childStarted();await globalThis.iteratorGate;globalThis.iteratorAfter.push(yUe(Z));globalThis.iteratorEfforts.push(Q);let request=buildRequest({model:Z,effort:Q,agentContext:tt.agentContext,max_tokens:cS},null);globalThis.sent.push(request);yield {...request,resolvedChildModel:Ot}}finally{globalThis.iteratorFinally.push(yUe(Z))}}`;

const recoveryLaunchModule = `${boundary}/$bunfs/root/chunk-3pr91mb5.js
async function Xo({agentInput:n,toolUseContext:e,canUseTool:s,assistantMessage:p,onProgress:y,timing:_,enclosingToolUseId:k}){let{subagent_type:R}=n;globalThis.recoveryCaptures.newAgentPrepared=true;return n}`;

const recoveryRequestModule = `${boundary}/$bunfs/root/chunk-sq7yspzm.js
function buildRequest(Z,R_){let cS=Z.max_tokens,Jm=Z.thinking,Yc={model:LT(Z.model),messages:R_!==null,metadata:a6e({agentContext:Z.agentContext}),max_tokens:cS,thinking:Jm,effort:Z.effort};return Yc}`;

export const CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE = [
  CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE,
  recoveryResumeModule,
  recoveryRunnerModule,
  recoveryLaunchModule,
  recoveryRequestModule,
  CLAUDE_AGENT_2_1_314_ROUTING_SIDECAR_SOURCE,
].join('\n');
