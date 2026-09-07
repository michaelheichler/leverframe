import type { PatchScriptModelConfig, PatchSiteResult } from './patch-transforms.js';
import { ONE_M_CONTEXT_WINDOW } from './context-model-id.js';

export interface NativeModelKnowledgeOutcome {
  content: string;
  result: PatchSiteResult;
}

const PATCH_NAME = 'PATCH 13: native model knowledge';
const PATCH_MARKER = '/*ccpatch:model-knowledge*/';
const MODULE_BOUNDARY = '\n//#__leverframe_claude_module__:';

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function siteResult(status: PatchSiteResult['status'], extra?: string): PatchSiteResult {
  return extra === undefined
    ? { status, name: PATCH_NAME }
    : { status, name: PATCH_NAME, extra };
}

function configuredModelKeys(config: PatchScriptModelConfig): string[] {
  const keys = new Set<string>();
  for (const [identity, rawEntry] of Object.entries(config)) {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    if (entry.context === undefined && entry.contextModes === undefined) continue;
    const defaultContext = entry.contextModes?.default ?? entry.context;
    const maximumContext = entry.contextModes?.maximum;
    const hasConfirmedMaximum = typeof maximumContext === 'number'
      && typeof defaultContext === 'number'
      && Number.isSafeInteger(maximumContext)
      && Number.isSafeInteger(defaultContext)
      && maximumContext > defaultContext;
    const hasReportedOneMContext = [defaultContext, maximumContext].some(value =>
      typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= ONE_M_CONTEXT_WINDOW,
    );
    for (const rawKey of [identity, entry.alias]) {
      if (rawKey === undefined) continue;
      const key = String(rawKey).trim().toLowerCase();
      if (key === '') continue;
      const bare = key.replace(/\[1m\]$/i, '');
      for (const suffix of ['', ...(hasReportedOneMContext ? ['[1m]'] : []), '[default]']) {
        keys.add(bare + suffix);
      }
      if (hasConfirmedMaximum) keys.add(bare + '[maximum]');
    }
  }
  return [...keys].sort();
}

function declaration(keys: readonly string[]): string {
  const table = JSON.stringify(Object.fromEntries(keys.map(key => [key, true])));
  return PATCH_MARKER
    + 'var __lfcKnownModels=Object.assign(Object.create(null),JSON.parse('
    + JSON.stringify(table)
    + '));'
    + 'var __lfcIsKnownModel=function(model){'
    + 'var __lfcStaticKnown=Object.prototype.hasOwnProperty.call(__lfcKnownModels,model);'
    + 'if(typeof globalThis!=="object"||globalThis===null)return __lfcStaticKnown;'
    + 'var __lfcStore=globalThis.__lfcContextWindows;'
    + 'if(!__lfcStore||typeof __lfcStore!=="object"||!Object.prototype.hasOwnProperty.call(__lfcStore,model))return __lfcStaticKnown;'
    + 'var __lfcValue=__lfcStore[model];'
    + 'return Number.isSafeInteger(__lfcValue)&&__lfcValue>0;'
    + '};';
}

function refreshExisting(source: string, replacement: string): NativeModelKnowledgeOutcome {
  const pattern = new RegExp(
    escaped(PATCH_MARKER)
      + 'var __lfcKnownModels=Object\\.assign\\(Object\\.create\\(null\\),JSON\\.parse\\("(?:[^"\\\\]|\\\\.)*"\\)\\);'
      + '(?:var __lfcIsKnownModel=function\\(model\\)\\{[\\s\\S]*?\\};)?',
  );
  const matches = source.match(new RegExp(pattern.source, 'g'));
  if (!matches || matches.length !== 1) {
    return {
      content: source,
      result: siteResult('FAIL', 'existing model knowledge marker is ambiguous'),
    };
  }
  let content = source.replace(pattern, replacement);
  const legacyPredicate = /\|\|Object\.prototype\.hasOwnProperty\.call\(__lfcKnownModels,([A-Za-z_$][\w$]*)\)/g;
  const legacyMatches = content.match(legacyPredicate) ?? [];
  if (legacyMatches.length > 1) {
    return {
      content: source,
      result: siteResult('FAIL', 'existing model knowledge predicate is ambiguous'),
    };
  }
  if (legacyMatches.length === 1) {
    content = content.replace(
      legacyPredicate,
      (_match, identity: string) => '||__lfcIsKnownModel(' + identity + ')',
    );
  }
  if (legacyMatches.length === 0 && !content.includes('__lfcIsKnownModel(')) {
    return {
      content: source,
      result: siteResult('FAIL', 'existing model knowledge predicate is missing'),
    };
  }
  return content === source
    ? { content: source, result: siteResult('SKIP', 'already integrated') }
    : { content, result: siteResult('OK') };
}

export function applyNativeModelKnowledge(
  source: string,
  config: PatchScriptModelConfig,
): NativeModelKnowledgeOutcome {
  const keys = configuredModelKeys(config);
  if (source.includes(PATCH_MARKER)) return refreshExisting(source, declaration(keys));
  if (keys.length === 0) return { content: source, result: siteResult('SKIP', 'no confirmed model metadata') };

  const nativeBundleSource = source.includes(MODULE_BOUNDARY)
    || source.includes('/*__LEVERFRAME_CLAUDE_MODULE_BOUNDARY__*/');
  const anchor = /function [A-Za-z_$][\w$]*\(e\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(e\);return ([A-Za-z_$][\w$]*)\(\1\)!==void 0\|\|([A-Za-z_$][\w$]*)\.has\(\1\)\|\|\1===([A-Za-z_$][\w$]*)\}/;
  const anchorMatches = source.match(new RegExp(anchor.source, 'g')) ?? [];
  if (anchorMatches.length > 1) {
    return {
      content: source,
      result: siteResult(
        nativeBundleSource ? 'FAIL' : 'SKIP',
        'native model knowledge anchor matched ' + anchorMatches.length + ' functions',
      ),
    };
  }
  const match = anchor.exec(source);
  if (!match) {
    return {
      content: source,
      result: siteResult(nativeBundleSource ? 'FAIL' : 'SKIP', 'native model knowledge anchor not found'),
    };
  }

  const identity = match[1]!;
  const replacement = match[0]
    .replace(
      `||${match[4]!}.has(${identity})||${identity}===${match[5]!}`,
      `||${match[4]!}.has(${identity})||${identity}===${match[5]!}||__lfcIsKnownModel(${identity})`,
    );
  const content = source.replace(anchor, declaration(keys) + replacement);
  return content === source
    ? { content: source, result: siteResult('FAIL', 'replacement made no change') }
    : { content, result: siteResult('OK') };
}
