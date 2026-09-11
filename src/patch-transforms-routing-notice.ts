

import type { PatchScriptModelConfig, PatchSiteResult } from './patch-transforms.js';
import { applyModernRoutingNotice } from './patch-transforms-routing-modern.js';

export const ROUTING_NOTICE_MARKER = '/*ccpatch:routing-notice*/';
export const ROUTING_NOTICE_HANDOFF_MARKER = '/*ccpatch:routing-notice-handoff*/';

export const AGENT_DESCRIPTION_MARKER = '/*ccpatch:agent-description*/';

export interface RoutingNoticePatchOutcome {
  content: string;
  results: PatchSiteResult[];
}

const IDENT = '[$A-Za-z_][$\\w]*';

function displayKeys(value: string): string[] {
  const bare = String(value).trim().toLowerCase().replace(/\[1m\]$/i, '');
  return [...new Set([bare, bare + '[1m]'])];
}

export function buildRoutingDisplayTable(config: PatchScriptModelConfig): Record<string, string> {
  const table: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [identity, rawEntry] of Object.entries(config)) {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    const display = typeof entry.display === 'string' ? entry.display.trim().replace(/\s+/g, ' ') : '';
    if (display.trim() === '') continue;
    for (const key of displayKeys(identity)) table[key] = display;
    if (entry.alias !== undefined) {
      for (const key of displayKeys(String(entry.alias))) table[key] = display;
    }
  }
  return table;
}

export function buildRoutingEffortTable(config: PatchScriptModelConfig): Record<string, string> {
  const table: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [identity, rawEntry] of Object.entries(config)) {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    const level = entry.effort && typeof entry.effort.defaultLevel === 'string' ? entry.effort.defaultLevel.trim() : '';
    if (level === '') continue;
    for (const key of displayKeys(identity)) table[key] = level;
    if (entry.alias !== undefined) {
      for (const key of displayKeys(String(entry.alias))) table[key] = level;
    }
  }
  return table;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function count(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  return source.match(new RegExp(pattern.source, flags))?.length ?? 0;
}

function replaceOnce(source: string, pattern: RegExp, replacement: string | ((match: string) => string)): string | undefined {
  if (count(source, pattern) !== 1) return undefined;
  if (typeof replacement === 'string') return source.replace(pattern, replacement);
  return source.replace(pattern, replacement);
}

const callSiteAnchor = new RegExp(
  'let ' + IDENT + '=' + IDENT + '\\(' + IDENT + '\\),(' + IDENT + ')=' + IDENT + '\\([^;{}]*?\\);'
  + IDENT + '\\.agentLifecycle\\.markTypeInvoked\\(' + IDENT + '\\.agentType\\);',
);

const callbackAnchor = new RegExp(
  'onModelRestricted:\\((' + IDENT + '),(' + IDENT + ')\\)=>' + IDENT + '\\?\\.\\(\\{type:"notification",notification:\\{'
  + 'key:`agent-model-restricted-\\$\\{(' + IDENT + ')\\.agentType\\}-\\$\\{' + IDENT + '\\(\\1\\)\\}`,'
  + 'text:`\\$\\{\\3\\.agentType\\} agent: \\$\\{' + IDENT + '\\(\\1,\\2\\)\\}`,'
  + 'priority:"medium",color:"warning",timeoutMs:1e4\\}\\}\\)',
);

const runnerSignatureAnchor = new RegExp(
  'async function\\*(' + IDENT + ')\\(\\{agentDefinition:' + IDENT + ',promptMessages:' + IDENT + ',toolUseContext:' + IDENT
  + ',[^{}]*?requiresStructuredOutput:(' + IDENT + ')\\}\\)',
);

const runnerSignaturePatched = new RegExp(
  'async function\\*(' + IDENT + ')\\(\\{agentDefinition:' + IDENT + ',promptMessages:' + IDENT + ',toolUseContext:' + IDENT
  + ',[^{}]*?requiresStructuredOutput:(' + IDENT + '),onRoutingNotice:ccRoutingNotice,ccRoutingModelId\\}\\)',
);

const runnerContextAnchor = new RegExp(
  '(' + IDENT + ')=' + IDENT + '\\(r,\\{options:' + IDENT + ',[^{}]*?agentId:(' + IDENT + '),isBackgroundAgent:' + IDENT
  + ',[^{}]*?permissionLayers:' + IDENT + ',[^{}]*?contentReplacementState:' + IDENT + '\\}\\);',
);

const callSignatureAnchor = new RegExp(
  'async call\\(\\{prompt:' + IDENT + ',subagent_type:' + IDENT + ',description:(' + IDENT + '),model:' + IDENT
  + ',run_in_background:' + IDENT + ',name:' + IDENT + ',isolation:' + IDENT + ',cwd:' + IDENT + '\\},' + IDENT
  + ',' + IDENT + ',' + IDENT + ',' + IDENT + '\\)\\{',
);

const CURRENT_ROUTING_MARKER = '/*ccintegration:routing*/';
const currentCallSignatureAnchor = new RegExp(
  'async call\\(\\{prompt:' + IDENT + ',subagent_type:' + IDENT + ',description:(' + IDENT + '),model:' + IDENT
  + ',run_in_background:' + IDENT + ',name:' + IDENT + ',isolation:' + IDENT + ',cwd:' + IDENT + '\\},' + IDENT
  + ',' + IDENT + ',' + IDENT + ',(' + IDENT + ')\\)\\{',
);
const currentResolvedModelAnchor = new RegExp(
  '((?:let|,))(' + IDENT + ')=' + IDENT + '\\([^;{}]{1,400}\\);(' + IDENT + ')\\.agentLifecycle\\.markTypeInvoked\\((' + IDENT + ')\\.agentType\\);',
);

function applyCurrentRoutingSite(source: string, config: PatchScriptModelConfig): RoutingNoticePatchOutcome | undefined {
  if (source.includes(CURRENT_ROUTING_MARKER)) {
    return {
      content: source,
      results: [
        { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'already integrated' },
        { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'already integrated' },
      ],
    };
  }
  if (count(source, currentCallSignatureAnchor) !== 1 || count(source, currentResolvedModelAnchor) !== 1) return undefined;
  const signature = source.match(currentCallSignatureAnchor)!;
  const resolved = source.match(currentResolvedModelAnchor)!;
  const descVar = signature[1]!;
  const noticeVar = signature[2]!;
  const modelVar = resolved[2]!;
  const agentDefVar = resolved[4]!;
  const table = JSON.stringify(buildRoutingDisplayTable(config));
  const efforts = JSON.stringify(buildRoutingEffortTable(config));
  const snippet = `${CURRENT_ROUTING_MARKER}{let _lft=Object.assign(Object.create(null),${table})[String(${modelVar}||"").trim().toLowerCase()],`
    + `_lfd=_lft!==void 0?_lft:String(${modelVar}||""),_lfe=Object.assign(Object.create(null),${efforts})[String(${modelVar}||"").trim().toLowerCase()]||"";`
    + `_lfd=String(_lfd).trim().replace(/\\s+/g," ");_lfe=String(_lfe).trim().replace(/\\s+/g," ");`
    + `if(${descVar}.indexOf(" \\u00b7 "+_lfd)===-1)${descVar}=${descVar}+" \\u00b7 "+_lfd+(_lfe?" \\u00b7 "+_lfe:"");`
    + `${noticeVar}?.({type:"notification",notification:{key:"leverframe-routing-success-"+${agentDefVar}.agentType,text:"Routing successful. Model "+_lfd+" with Reasoning "+_lfe,priority:"high",timeoutMs:1e4}})}`;
  const patched = replaceOnce(source, currentResolvedModelAnchor, (match: string) => `${match}${snippet}`);
  if (patched === undefined) return undefined;
  return {
    content: patched,
    results: [
      { status: 'OK', name: 'PATCH 10: routing notice' },
      { status: 'OK', name: 'PATCH 10d: agent description indicator' },
    ],
  };
}

interface RunnerCaptures {
  runnerFn: string;
  requiresStructuredOutputParam: string;
}

interface ContextCaptures {
  contextVar: string;
  agentIdVar: string;
}

function callbackSnippet(modelIdVar: string): string {
  return `${ROUTING_NOTICE_MARKER}onRoutingNotice:d,ccRoutingModelId:${modelIdVar}`;
}

function signatureSnippet(requiresStructuredOutputParam: string): { from: string; to: string } {
  return {
    from: `requiresStructuredOutput:${requiresStructuredOutputParam}})`,
    to: `requiresStructuredOutput:${requiresStructuredOutputParam},onRoutingNotice:ccRoutingNotice,ccRoutingModelId})`,
  };
}

function handoffPrefix(): string { return `${ROUTING_NOTICE_HANDOFF_MARKER}if(d?.replHydration?.kind!=="resume"){`; }

interface HandoffOptions {
  table: Record<string, string>;
  effortTable: Record<string, string>;
  agentIdVar: string;
}

function handoffSnippet(options: HandoffOptions): string {
  const { table, effortTable, agentIdVar } = options;
  const serializedTable = JSON.stringify(table).replaceAll('/*ccpatch:', '\\u002f*ccpatch:');
  const serializedEffort = JSON.stringify(effortTable).replaceAll('/*ccpatch:', '\\u002f*ccpatch:');
  return handoffPrefix()
    + `let _ccm=Object.assign(Object.create(null),${serializedTable})[String(ccRoutingModelId||"").trim().toLowerCase()],`
    + `_ccd=_ccm!==void 0?_ccm:String(ccRoutingModelId||""),`
    + `_ccr=Object.assign(Object.create(null),${serializedEffort})[String(ccRoutingModelId||"").trim().toLowerCase()]||"";`
    + `_ccd=String(_ccd).trim().replace(/\\s+/g," ");_ccr=String(_ccr).trim().replace(/\\s+/g," ");`
    + `ccRoutingNotice?.({type:"notification",notification:{key:\`leverframe-routing-success-\${${agentIdVar}}\`,`
    + `text:\`Routing successful. Model \${_ccd} with Reasoning \${_ccr}\`,`
    + `segments:[{text:"Routing successful. Model "},{text:_ccd,color:"suggestion",bold:!0},{text:" with Reasoning "},{text:_ccr,color:"success",bold:!0}],`
    + `priority:"high",timeoutMs:1e4}})}`;
}

function handoffPattern(): RegExp {
  return new RegExp(
    escaped(ROUTING_NOTICE_HANDOFF_MARKER)
      + 'if\\(d\\?\\.replHydration\\?\\.kind!=="resume"\\)\\{[\\s\\S]*?'
      + 'ccRoutingNotice\\?\\.\\(\\{type:"notification",notification:\\{[\\s\\S]*?timeoutMs:1e4\\}\\}\\)\\}',
  );
}

const AGENT_DESCRIPTION_SEP = '\\u00b7';
const AGENT_DESCRIPTION_SEP_PATTERN = '(?:\\\\u00b7|\\xB7)';

interface AgentDescriptionOptions {
  descVar: string;
  modelIdVar: string;
  table: Record<string, string>;
  effortTable: Record<string, string>;
}

function agentDescriptionSnippet(options: AgentDescriptionOptions): string {
  const { descVar, modelIdVar, table, effortTable } = options;
  const serializedTable = JSON.stringify(table).replaceAll('/*ccpatch:', '\\u002f*ccpatch:');
  const serializedEffort = JSON.stringify(effortTable).replaceAll('/*ccpatch:', '\\u002f*ccpatch:');
  return `${AGENT_DESCRIPTION_MARKER}{`
    + `let _ccat=Object.assign(Object.create(null),${serializedTable})[String(${modelIdVar}||"").trim().toLowerCase()],`
    + `_ccad=_ccat!==void 0?_ccat:String(${modelIdVar}||""),`
    + `_ccae=Object.assign(Object.create(null),${serializedEffort})[String(${modelIdVar}||"").trim().toLowerCase()]||"";`
    + `_ccad=String(_ccad).trim().replace(/\\s+/g," ");_ccae=String(_ccae).trim().replace(/\\s+/g," ");`
    + `if(${descVar}.indexOf(" ${AGENT_DESCRIPTION_SEP} "+_ccad)===-1){`
    + `${descVar}=${descVar}+" ${AGENT_DESCRIPTION_SEP} "+_ccad+(_ccae?" ${AGENT_DESCRIPTION_SEP} "+_ccae:"");}}`;
}

function agentDescriptionPattern(): RegExp {
  return new RegExp(
    escaped(AGENT_DESCRIPTION_MARKER)
      + '\\{let _ccat=Object\\.assign\\(Object\\.create\\(null\\),[\\s\\S]*?'
      + '\\+\\(_ccae\\?" ' + AGENT_DESCRIPTION_SEP_PATTERN + ' "\\+_ccae:""\\);\\}\\}',
  );
}

function agentDescriptionOutcome(status: PatchSiteResult['status'], extra?: string): PatchSiteResult {
  return { status, name: 'PATCH 10d: agent description indicator', ...(extra === undefined ? {} : { extra }) };
}

function matchCallSignatureDescVar(source: string): string | undefined {
  if (count(source, callSignatureAnchor) !== 1) return undefined;
  return source.match(callSignatureAnchor)?.[1];
}

function matchCallSiteModelIdVar(source: string): string | undefined {
  if (count(source, callSiteAnchor) !== 1) return undefined;
  return source.match(callSiteAnchor)?.[1];
}

function refreshAgentDescription(source: string, config: PatchScriptModelConfig): { content: string; result: PatchSiteResult } {
  const modelIdVar = matchCallSiteModelIdVar(source);
  const descVar = matchCallSignatureDescVar(source);
  if (modelIdVar === undefined || descVar === undefined) {
    return { content: source, result: agentDescriptionOutcome('SKIP', 'generated block could not be refreshed') };
  }
  const snippet = agentDescriptionSnippet({ descVar, modelIdVar, table: buildRoutingDisplayTable(config), effortTable: buildRoutingEffortTable(config) });
  const refreshed = replaceOnce(source, agentDescriptionPattern(), snippet);
  if (refreshed === undefined) return { content: source, result: agentDescriptionOutcome('SKIP', 'generated block could not be refreshed') };
  if (refreshed === source) return { content: source, result: agentDescriptionOutcome('SKIP', 'already patched') };
  return { content: refreshed, result: { status: 'OK', name: 'PATCH 10d: agent description indicator (refresh)' } };
}

function patchFreshAgentDescription(source: string, config: PatchScriptModelConfig): { content: string; result: PatchSiteResult } {
  const modelIdVar = matchCallSiteModelIdVar(source);
  if (modelIdVar === undefined) return { content: source, result: agentDescriptionOutcome('SKIP', 'call-site anchor not recognized') };
  const descVar = matchCallSignatureDescVar(source);
  if (descVar === undefined) return { content: source, result: agentDescriptionOutcome('SKIP', 'call signature anchor not recognized') };

  const snippet = agentDescriptionSnippet({ descVar, modelIdVar, table: buildRoutingDisplayTable(config), effortTable: buildRoutingEffortTable(config) });
  const patched = replaceOnce(source, callSiteAnchor, (match: string) => `${match}${snippet}`);
  if (patched === undefined) return { content: source, result: agentDescriptionOutcome('SKIP', 'could not inject description indicator') };
  return { content: patched, result: { status: 'OK', name: 'PATCH 10d: agent description indicator' } };
}

function applyAgentDescriptionSite(source: string, config: PatchScriptModelConfig): { content: string; result: PatchSiteResult } {
  const existingCount = count(source, agentDescriptionPattern());
  if (existingCount > 1) return { content: source, result: agentDescriptionOutcome('SKIP', 'ambiguous patch markers found') };
  if (existingCount === 1) return refreshAgentDescription(source, config);
  return patchFreshAgentDescription(source, config);
}

function outcome(source: string, status: PatchSiteResult['status'], extra?: string): RoutingNoticePatchOutcome {
  return {
    content: source,
    results: [{ status, name: 'PATCH 10: routing notice', ...(extra === undefined ? {} : { extra }) }],
  };
}

function refreshRoutingNotice(source: string, config: PatchScriptModelConfig): RoutingNoticePatchOutcome {
  if (count(source, runnerSignaturePatched) !== 1) return outcome(source, 'SKIP', 'generated block could not be refreshed');
  const contextMatch = source.match(runnerContextAnchor);
  if (!contextMatch) return outcome(source, 'SKIP', 'generated block could not be refreshed');
  const agentIdVar = contextMatch[2]!;

  const table = buildRoutingDisplayTable(config);
  const effortTable = buildRoutingEffortTable(config);
  const refreshedHandoff = replaceOnce(source, handoffPattern(), handoffSnippet({ table, effortTable, agentIdVar }));
  if (refreshedHandoff === undefined) return outcome(source, 'SKIP', 'generated block could not be refreshed');
  if (refreshedHandoff === source) return outcome(source, 'SKIP', 'already patched');
  return {
    content: refreshedHandoff,
    results: [{ status: 'OK', name: 'PATCH 10: routing notice (refresh)' }],
  };
}

function matchRunnerSignature(source: string): RunnerCaptures | undefined {
  if (count(source, runnerSignatureAnchor) !== 1) return undefined;
  const match = source.match(runnerSignatureAnchor);
  if (!match) return undefined;
  return { runnerFn: match[1]!, requiresStructuredOutputParam: match[2]! };
}

function matchRunnerContext(source: string): ContextCaptures | undefined {
  if (count(source, runnerContextAnchor) !== 1) return undefined;
  const match = source.match(runnerContextAnchor);
  if (!match) return undefined;
  return { contextVar: match[1]!, agentIdVar: match[2]! };
}

function patchFreshRoutingNotice(source: string, config: PatchScriptModelConfig): RoutingNoticePatchOutcome {
  const callCount = count(source, callSiteAnchor);
  const callbackCount = count(source, callbackAnchor);
  const signature = matchRunnerSignature(source);
  const context = matchRunnerContext(source);
  const callPresent = callCount > 0 || callbackCount > 0;
  const runnerPresent = signature !== undefined || context !== undefined;
  if (!callPresent && !runnerPresent) return outcome(source, 'SKIP', 'Agent launch anchor not recognized');
  if (callCount !== 1 || callbackCount !== 1) return outcome(source, 'SKIP', 'Agent call-site anchor not recognized');
  if (signature === undefined || context === undefined) return outcome(source, 'SKIP', 'runner anchor not recognized');

  const callSiteMatch = source.match(callSiteAnchor);
  if (!callSiteMatch) return outcome(source, 'SKIP', 'Agent call-site anchor not recognized');
  const modelIdVar = callSiteMatch[1]!;

  const callbackPatched = replaceOnce(source, callbackAnchor, (match: string) => `${match},${callbackSnippet(modelIdVar)}`);
  if (callbackPatched === undefined) return outcome(source, 'FAIL', 'Agent callback site could not be patched');

  const { from, to } = signatureSnippet(signature.requiresStructuredOutputParam);
  const signaturePatched = replaceOnce(
    callbackPatched,
    runnerSignatureAnchor,
    (match: string) => match.replace(from, to),
  );
  if (signaturePatched === undefined) return outcome(source, 'FAIL', 'runner signature could not be patched');

  const table = buildRoutingDisplayTable(config);
  const effortTable = buildRoutingEffortTable(config);
  const handoffPatched = replaceOnce(
    signaturePatched,
    runnerContextAnchor,
    (match: string) => `${match}${handoffSnippet({ table, effortTable, agentIdVar: context.agentIdVar })}`,
  );
  if (handoffPatched === undefined) return outcome(source, 'FAIL', 'runner handoff could not be patched');
  return {
    content: handoffPatched,
    results: [
      { status: 'OK', name: 'PATCH 10a: routing notice callback' },
      { status: 'OK', name: 'PATCH 10b: routing notice signature' },
      { status: 'OK', name: 'PATCH 10c: routing notice handoff' },
    ],
  };
}

function existingRoutingNoticeOutcome(
  source: string,
  config: PatchScriptModelConfig,
): RoutingNoticePatchOutcome | undefined {
  const primaryMarkerCount = count(source, new RegExp(callbackAnchor.source + ',' + escaped(ROUTING_NOTICE_MARKER)));
  const handoffMarkerCount = count(source, new RegExp(runnerContextAnchor.source + escaped(ROUTING_NOTICE_HANDOFF_MARKER)));
  if (primaryMarkerCount === 0 && handoffMarkerCount === 0) return undefined;

  const primaryPattern = new RegExp(
    callbackAnchor.source + ',' + escaped(ROUTING_NOTICE_MARKER) + 'onRoutingNotice:d,ccRoutingModelId:' + IDENT,
  );
  const handoffCount = count(source, new RegExp(runnerContextAnchor.source + escaped(handoffPrefix())));
  if (count(source, primaryPattern) !== 1 || handoffCount !== 1) {
    return outcome(source, 'SKIP', 'partial or ambiguous patch markers found');
  }
  return refreshRoutingNotice(source, config);
}

export function applyRoutingNoticeTransform(
  source: string,
  config: PatchScriptModelConfig,
): RoutingNoticePatchOutcome {
  const modern = applyModernRoutingNotice(source, buildRoutingDisplayTable(config));
  if (modern) return modern;
  if (source.includes(CURRENT_ROUTING_MARKER)) return applyCurrentRoutingSite(source, config)!;
  const base = existingRoutingNoticeOutcome(source, config) ?? patchFreshRoutingNotice(source, config);
  const described = applyAgentDescriptionSite(base.content, config);
  const legacy = { content: described.content, results: [...base.results, described.result] };
  const unrecognized = legacy.results.every(result =>
    result.status === 'SKIP' && result.extra?.toLowerCase().includes('anchor not recognized')
  );
  if (unrecognized) return applyCurrentRoutingSite(source, config) ?? legacy;
  return legacy;
}
