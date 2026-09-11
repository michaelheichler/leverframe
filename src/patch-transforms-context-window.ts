import type { PatchSiteResult } from './patch-transforms.js';

export interface NativeContextWindowOutcome {
  content: string;
  result: PatchSiteResult;
}

const PATCH_NAME = 'PATCH 7: per-model context window';
const CONTEXT_MARKER = '/*ccpatch:ctx*/';

function result(status: PatchSiteResult['status'], extra?: string, name = PATCH_NAME): PatchSiteResult {
  return extra === undefined
    ? { status, name }
    : { status, name, extra };
}

function contextSnippet(
  model: string,
  contextByKey: Record<string, number>,
): string {
  const contextTable = JSON.stringify(contextByKey);
  const contextLookup = 'Object.assign(Object.create(null),JSON.parse(' + JSON.stringify(contextTable) + '))';
  return CONTEXT_MARKER
    + 'var _ccw=' + contextLookup + '[String(' + model + '||"").trim().toLowerCase()];'
    + 'if(typeof globalThis==="object"&&globalThis!==null){'
    + 'var __lfcContextWindows=globalThis.__lfcContextWindows;'
    + 'var __lfcContextKey=String(' + model + '||"").trim().toLowerCase();'
    + 'if(__lfcContextWindows&&typeof __lfcContextWindows==="object"&&Object.prototype.hasOwnProperty.call(__lfcContextWindows,__lfcContextKey)){'
    + 'var __lfcContextValue=__lfcContextWindows[__lfcContextKey];'
    + 'if(Number.isSafeInteger(__lfcContextValue)&&__lfcContextValue>0)_ccw=__lfcContextValue;else _ccw=void 0;'
    + '}'
    + '}'
    + 'if(_ccw!==void 0)return _ccw;';
}

export function applyNativeContextWindow(
  source: string,
  contextByKey: Record<string, number>,
): NativeContextWindowOutcome {

  if (source.includes(CONTEXT_MARKER)) {
    const refreshName = PATCH_NAME + ' (refresh)';
    const refreshPattern = /(function [\w$]+\(([\w$]+),[\w$]+\)\{)\/\*ccpatch:ctx\*\/(?:var _ccw|var __lfcContextKey)[\s\S]*?if\((?:_ccw|__lfcContextValue)!==void 0\)return (?:_ccw|__lfcContextValue);/;
    const matches = source.match(new RegExp(refreshPattern.source, 'g')) ?? [];
    if (matches.length !== 1) {
      return {
        content: source,
        result: result('FAIL', 'context window marker matched ' + matches.length + ' snippets', refreshName),
      };
    }
    const content = source.replace(refreshPattern, (_match, head: string, model: string) =>
      head + contextSnippet(model, contextByKey),
    );
    return content === source
      ? { content: source, result: result('SKIP', 'already integrated', refreshName) }
      : { content, result: result('OK', undefined, refreshName) };
  }

  const anchor =
    /(function [\w$]+\(([\w$]+),([\w$]+)\)\{)(let ([\w$]+)=[\w$]+\(\);if\(\5!==void 0\)return \5;if\([\w$]+\(\2,\3\)\)return [\w$]+;return [\w$]+\(\2,\3\)\})/;
  const matches = source.match(new RegExp(anchor.source, 'g')) ?? [];
  if (matches.length === 0) return { content: source, result: result('FAIL', 'anchor not found') };
  if (matches.length > 1) {
    return {
      content: source,
      result: result('FAIL', 'anchor matched ' + matches.length + ' functions (expected 1)'),
    };
  }
  const content = source.replace(anchor, (_match, head: string, model: string, _options: string, body: string) =>
    head + contextSnippet(model, contextByKey) + body,
  );
  return content === source
    ? { content: source, result: result('FAIL', 'replacement made no change') }
    : { content, result: result('OK') };
}
