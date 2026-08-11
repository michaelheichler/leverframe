// Why: Keep binary patch logic isolated from runtime formatting.
//
// Per-release verification (do this whenever a new Claude Code version drifts
// PATCH 10 to SKIP): grep the installed `claude` binary's extracted JS for the
// four stable literals below (agentLifecycle.markTypeInvoked, onModelRestricted:,
// agent-model-restricted-, the async function* runner signature carrying
// requiresStructuredOutput:, and the runner-context call carrying agentId:/
// isBackgroundAgent:/permissionLayers:/contentReplacementState:). Confirm the
// four anchors below still match with a single capture-group hit each. Then,
// specifically, verify which local variable actually holds the *resolved*
// model id in scope at the runner-context injection point — do NOT assume the
// minified name that looks similar to a call-site variable is the same
// binding; different functions reuse short names independently. As of Claude
// Code 2.1.227 the call-site "model" variable and the *runner's own* internal
// model variable are NOT the same lexical binding (the runner resolves its
// own effective model deep in its body, with no stable literal nearby), so
// this file threads the call-site model id across the function boundary via
// a new `ccRoutingModelId` property on the shared options object instead of
// guessing a runner-local variable name.
//
// Agent description indicator (PATCH 10d, optional/independent of PATCH
// 10a-10c above): verified in the installed 2.1.227 bundle that the Agent
// tool's synchronous `call()` method (not the async generator runner) is
// where both the resolved model id (the same `nle(...)`/`XP(l)` call-site
// binding captured by callSiteAnchor) and the *unmutated* task description
// local are in scope together, right after `agentLifecycle.markTypeInvoked`.
// That description local (destructured as `description:(descVar)` in the
// `call()` signature — matched by callSignatureAnchor on the schema's own
// property-key literals, which are not minifier-renamed) flows unchanged
// into the async-launch tool result (`description:r`) and the teammate-spawn
// payload (`description:r`), both of which the TUI uses to keep the
// persistent "Agent(description)" invocation line up to date for the life of
// the call — mutating it here, before those later reads, is early enough to
// be reflected. Re-verify this per release the same way as the other four
// anchors: grep for `async call({prompt:`, confirm callSignatureAnchor still
// captures a single description identifier, and confirm that identifier
// still reaches the `description:` field of the async-launch/teammate-spawn
// result objects unmutated before this site's injection point.
import type { PatchScriptModelConfig, PatchSiteResult } from './patch-transforms.js';

export const ROUTING_NOTICE_MARKER = '/*ccpatch:routing-notice*/';
export const ROUTING_NOTICE_HANDOFF_MARKER = '/*ccpatch:routing-notice-handoff*/';
// PATCH 10d: appends " · <display> · <effort>" to the Agent tool's own
// `description` local (the same value that flows into the async-launch tool
// result and the teammate-spawn payload) so the invocation line the TUI
// renders (e.g. "Agent(description)") carries a persistent routing
// indicator for the agent's whole lifetime. Independent, optional site: it
// SKIPs (never FAILs) when its anchors drift, and never blocks PATCH
// 10a-10c. See "Agent description indicator" in the file header below.
export const AGENT_DESCRIPTION_MARKER = '/*ccpatch:agent-description*/';

export interface RoutingNoticePatchOutcome {
  content: string;
  results: PatchSiteResult[];
}

// Matches any valid JS identifier (including minifier-generated `$`-prefixed names).
const IDENT = '[$A-Za-z_][$\\w]*';

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

// Why: nS()/sJe()/qce() are unstable minified CC internals that vary per
// release and cannot be captured with a stable anchor; the transform's own
// config already carries a declared default effort per model, so use that
// as the source of truth for the routing notice instead of guessing at
// version-specific helper names (see file header).
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

// --- Structure-based anchors (stable literals + identifier capture groups) ---
//
// Call site: `let A=B(l),(modelIdVar)=C(...);l.agentLifecycle.markTypeInvoked(D.agentType);`
const callSiteAnchor = new RegExp(
  'let ' + IDENT + '=' + IDENT + '\\(' + IDENT + '\\),(' + IDENT + ')=' + IDENT + '\\([^;{}]*?\\);'
  + IDENT + '\\.agentLifecycle\\.markTypeInvoked\\(' + IDENT + '\\.agentType\\);',
);

// Callback: `onModelRestricted:(p1,p2)=>d?.({...key:`agent-model-restricted-${agentDefVar.agentType}-${fn(p1)}`...})`
const callbackAnchor = new RegExp(
  'onModelRestricted:\\((' + IDENT + '),(' + IDENT + ')\\)=>' + IDENT + '\\?\\.\\(\\{type:"notification",notification:\\{'
  + 'key:`agent-model-restricted-\\$\\{(' + IDENT + ')\\.agentType\\}-\\$\\{' + IDENT + '\\(\\1\\)\\}`,'
  + 'text:`\\$\\{\\3\\.agentType\\} agent: \\$\\{' + IDENT + '\\(\\1,\\2\\)\\}`,'
  + 'priority:"medium",color:"warning",timeoutMs:1e4\\}\\}\\)',
);

// Runner signature: `async function*(runnerFn)({agentDefinition:e,promptMessages:t,toolUseContext:r,...,requiresStructuredOutput:(param)})`
const runnerSignatureAnchor = new RegExp(
  'async function\\*(' + IDENT + ')\\(\\{agentDefinition:' + IDENT + ',promptMessages:' + IDENT + ',toolUseContext:' + IDENT
  + ',[^{}]*?requiresStructuredOutput:(' + IDENT + ')\\}\\)',
);
// Same signature after PATCH 10 already added the onRoutingNotice param + model-id channel.
const runnerSignaturePatched = new RegExp(
  'async function\\*(' + IDENT + ')\\(\\{agentDefinition:' + IDENT + ',promptMessages:' + IDENT + ',toolUseContext:' + IDENT
  + ',[^{}]*?requiresStructuredOutput:(' + IDENT + '),onRoutingNotice:ccRoutingNotice,ccRoutingModelId\\}\\)',
);

// Runner context: `(contextVar)=fn(r,{options:...,agentId:(agentIdVar),isBackgroundAgent:...,...,permissionLayers:...,...,contentReplacementState:...});`
const runnerContextAnchor = new RegExp(
  '(' + IDENT + ')=' + IDENT + '\\(r,\\{options:' + IDENT + ',[^{}]*?agentId:(' + IDENT + '),isBackgroundAgent:' + IDENT
  + ',[^{}]*?permissionLayers:' + IDENT + ',[^{}]*?contentReplacementState:' + IDENT + '\\}\\);',
);

// PATCH 10d anchor: the Agent tool's `call()` method signature, destructuring
// the raw tool input. `description:(descVar)` is the same local that flows,
// unmutated elsewhere, into the async-launch result (`description:r`) and
// the teammate-spawn payload (`description:r`) — see file header. Property
// key literals (`prompt:`, `subagent_type:`, `description:`, `model:`,
// `run_in_background:`, `name:`, `isolation:`, `cwd:`) come straight from the
// tool's zod schema and are not minifier-renamed.
const callSignatureAnchor = new RegExp(
  'async call\\(\\{prompt:' + IDENT + ',subagent_type:' + IDENT + ',description:(' + IDENT + '),model:' + IDENT
  + ',run_in_background:' + IDENT + ',name:' + IDENT + ',isolation:' + IDENT + ',cwd:' + IDENT + '\\},' + IDENT
  + ',' + IDENT + ',' + IDENT + ',' + IDENT + '\\)\\{',
);

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

// Middle dot separator matching the requested indicator format
// "<description> · <display> · <effort>". Not a regex metacharacter, so it
// needs no escaping in the patterns built below.
const AGENT_DESCRIPTION_SEP = '·';

interface AgentDescriptionOptions {
  descVar: string;
  modelIdVar: string;
  table: Record<string, string>;
  effortTable: Record<string, string>;
}

// Why: computing _ccad (the resolved display text) BEFORE the guard, then
// gating the append on an exact-suffix check (`" · "+_ccad` not already
// present), avoids false-suppressing the indicator for a user-written
// description that happens to already contain " · " for unrelated reasons
// (e.g. "check A · B"). Only a genuinely already-appended indicator (the
// exact display value we're about to append) skips re-append. Everything is
// wrapped in an anonymous block so `_ccat`/`_ccad`/`_ccae` never leak into
// the rest of `call()`'s scope even when the inner guard is false.
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

// Broad marker+literal-tail match (mirrors handoffPattern's approach): the
// serialized display/effort tables embed `{`/`}`, so a bare lazy `[\s\S]*?\}`
// would stop at the first table brace instead of the block's real close.
// Anchoring on the distinctive closing literal avoids that, and because the
// snippet is appended *after* callSiteAnchor/callSignatureAnchor (not inside
// them), those anchors still match fresh source for refresh, so this pattern
// never needs to capture/backreference the inner variable names. The tail
// now closes two braces: the guard `if` and the wrapping anonymous block.
function agentDescriptionPattern(): RegExp {
  return new RegExp(
    escaped(AGENT_DESCRIPTION_MARKER)
      + '\\{let _ccat=Object\\.assign\\(Object\\.create\\(null\\),[\\s\\S]*?'
      + '\\+\\(_ccae\\?" ' + AGENT_DESCRIPTION_SEP + ' "\\+_ccae:""\\);\\}\\}',
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

// Why: split fresh-patch from refresh so each stays within the hook's
// 50-line function limit and mirrors refreshRoutingNotice's structure.
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

// Why: this site is optional (per PATCH 10d design) — it must SKIP, never
// FAIL, and must never block PATCH 10a-10c even when its own anchors drift.
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
  const base = existingRoutingNoticeOutcome(source, config) ?? patchFreshRoutingNotice(source, config);
  const described = applyAgentDescriptionSite(base.content, config);
  return { content: described.content, results: [...base.results, described.result] };
}
