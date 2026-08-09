// Why: Keep binary patch logic isolated from runtime formatting.
import type { PatchScriptModelConfig, PatchSiteResult } from './patch-transforms.js';
export const ROUTING_NOTICE_MARKER = '/*ccpatch:routing-notice*/';
export const ROUTING_NOTICE_HANDOFF_MARKER = '/*ccpatch:routing-notice-handoff*/';
export interface RoutingNoticePatchOutcome {
  content: string;
  results: PatchSiteResult[];
}
function displayKeys(value: string): string[] {
  const bare = String(value).trim().toLowerCase().replace(/\[1m\]$/i, '');
  return [...new Set([bare, bare + '[1m]'])];
}
// Why: Keep generated lookup data independent from mutable bundle state.
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

function callbackSnippet(): string { return `${ROUTING_NOTICE_MARKER}onRoutingNotice:d`; }
function handoffPrefix(): string { return `${ROUTING_NOTICE_HANDOFF_MARKER}if(d?.replHydration?.kind!=="resume"){`; }
function handoffSnippet(table: Record<string, string>): string {
  const serializedTable = JSON.stringify(table).replaceAll('/*ccpatch:', '\\u002f*ccpatch:');
  return handoffPrefix() + `let _ccm=Object.assign(Object.create(null),${serializedTable})[String(ne||"").trim().toLowerCase()],_ccd=_ccm!==void 0?_ccm:qce(ne)||String(ne||""),_ccr=nS(st);_ccr=_ccr===void 0?sJe(ne):_ccr;_ccd=String(_ccd).trim().replace(/\\s+/g," ");_ccr=String(_ccr).trim().replace(/\\s+/g," ");ccRoutingNotice?.({type:"notification",notification:{key:\`leverframe-routing-success-\${se}\`,text:\`Routing successful. Model \${_ccd} with Reasoning \${_ccr}\`,segments:[{text:"Routing successful. Model "},{text:_ccd,color:"suggestion",bold:!0},{text:" with Reasoning "},{text:_ccr,color:"success",bold:!0}],priority:"high",timeoutMs:1e4}})}`;
}

const callSiteAnchor = /let Y=eP\(l\),ne=fse\(aZe\(V,Y\),Y,H\?void 0:f,S\);l\.agentLifecycle\.markTypeInvoked\(V\.agentType\);/;
const callbackAnchor = /onModelRestricted:\(Je,rt\)=>d\?\.\(\{type:"notification",notification:\{key:`agent-model-restricted-\$\{V\.agentType\}-\$\{Hbe\(Je\)\}`,text:`\$\{V\.agentType\} agent: \$\{XF\(Je,rt\)\}`,priority:"medium",color:"warning",timeoutMs:1e4\}\}\)/;
const runnerSignatureAnchor = /async function\*g5\(\{agentDefinition:e,promptMessages:t,toolUseContext:r,[^{}]*?requiresStructuredOutput:W\}\)/;
const runnerSignaturePatched = /async function\*g5\(\{agentDefinition:e,promptMessages:t,toolUseContext:r,[^{}]*?requiresStructuredOutput:W,onRoutingNotice:ccRoutingNotice\}\)/;
const runnerContextAnchor = /st=Q4o\(r,\{options:je,agentId:se,isBackgroundAgent:o,[^{}]*?permissionLayers:yt,[^{}]*?contentReplacementState:S\}\);/;

function handoffPattern(): RegExp {
  return new RegExp(
    escaped(ROUTING_NOTICE_HANDOFF_MARKER)
      + 'if\\(d\\?\\.replHydration\\?\\.kind!=="resume"\\)\\{[\\s\\S]*?'
      + 'ccRoutingNotice\\?\\.\\(\\{type:"notification",notification:\\{[\\s\\S]*?timeoutMs:1e4\\}\\}\\)\\}',
  );
}

function outcome(source: string, status: PatchSiteResult['status'], extra?: string): RoutingNoticePatchOutcome {
  return {
    content: source,
    results: [{ status, name: 'PATCH 10: routing notice', ...(extra === undefined ? {} : { extra }) }],
  };
}

function refreshRoutingNotice(source: string, config: PatchScriptModelConfig): RoutingNoticePatchOutcome {
  const refreshedCallback = replaceOnce(source, new RegExp(escaped(callbackSnippet())), callbackSnippet());
  const refreshedSignature = refreshedCallback === undefined
    ? undefined
    : replaceOnce(refreshedCallback, runnerSignaturePatched, (match: string) => match);
  const refreshedHandoff = refreshedSignature === undefined
    ? undefined
    : replaceOnce(refreshedSignature, handoffPattern(), handoffSnippet(buildRoutingDisplayTable(config)));
  if (refreshedHandoff === undefined) return outcome(source, 'SKIP', 'generated block could not be refreshed');
  if (refreshedHandoff === source) return outcome(source, 'SKIP', 'already patched');
  return {
    content: refreshedHandoff,
    results: [{ status: 'OK', name: 'PATCH 10: routing notice (refresh)' }],
  };
}

function patchFreshRoutingNotice(source: string, config: PatchScriptModelConfig): RoutingNoticePatchOutcome {
  const callCount = count(source, callSiteAnchor);
  const callbackCount = count(source, callbackAnchor);
  const signatureCount = count(source, runnerSignatureAnchor);
  const contextCount = count(source, runnerContextAnchor);
  const callPresent = callCount > 0 || callbackCount > 0;
  const runnerPresent = signatureCount > 0 || contextCount > 0;
  if (!callPresent && !runnerPresent) return outcome(source, 'SKIP', 'Agent launch anchor not recognized');
  if (callCount !== 1 || callbackCount !== 1) return outcome(source, 'SKIP', 'Agent call-site anchor not recognized');
  if (signatureCount !== 1 || contextCount !== 1) return outcome(source, 'SKIP', 'runner anchor not recognized');

  const callbackPatched = replaceOnce(source, callbackAnchor, (match: string) => `${match},${callbackSnippet()}`);
  if (callbackPatched === undefined) return outcome(source, 'FAIL', 'Agent callback site could not be patched');
  const signaturePatched = replaceOnce(
    callbackPatched,
    runnerSignatureAnchor,
    (match: string) => match.replace('requiresStructuredOutput:W})', 'requiresStructuredOutput:W,onRoutingNotice:ccRoutingNotice})'),
  );
  if (signaturePatched === undefined) return outcome(source, 'FAIL', 'runner signature could not be patched');
  const handoffPatched = replaceOnce(
    signaturePatched,
    runnerContextAnchor,
    (match: string) => `${match}${handoffSnippet(buildRoutingDisplayTable(config))}`,
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

  const primaryCount = count(source, new RegExp(callbackAnchor.source + ',' + escaped(callbackSnippet())));
  const handoffCount = count(source, new RegExp(runnerContextAnchor.source + escaped(handoffPrefix())));
  if (primaryCount !== 1 || handoffCount !== 1) {
    return outcome(source, 'SKIP', 'partial or ambiguous patch markers found');
  }
  return refreshRoutingNotice(source, config);
}

export function applyRoutingNoticeTransform(
  source: string,
  config: PatchScriptModelConfig,
): RoutingNoticePatchOutcome {
  return existingRoutingNoticeOutcome(source, config) ?? patchFreshRoutingNotice(source, config);
}
