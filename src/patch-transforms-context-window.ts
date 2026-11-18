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
    const refreshPattern = /(function [\w$]+\(([\w$]+),[\w$]+(?:,[\w$]+)?\)\{)\/\*ccpatch:ctx\*\/(?:var _ccw|var __lfcContextKey)[\s\S]*?if\((?:_ccw|__lfcContextValue)!==void 0\)return (?:_ccw|__lfcContextValue);/;
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

  const legacy =
    /(function [\w$]+\(([\w$]+),([\w$]+)\)\{)(let ([\w$]+)=[\w$]+\(\);if\(\5!==void 0\)return \5;if\([\w$]+\(\2,\3\)\)return [\w$]+;return [\w$]+\(\2,\3\)\})/;
  const current =
    /(function [\w$]+\(([\w$]+),([\w$]+),([\w$]+)\)\{)(let ([\w$]+)=[\w$]+\(\);if\(\6!==void 0\)return \6;if\([\w$]+\(\2,\3,\4\)\)\{let ([\w$]+)=[\w$]+\([\w$]+\([\w$]+\(\2\)\)\);return Math\.max\([\w$]+\(\2,\4\),\7\?\.maximum_window\?\?\7\?\.window\?\?0,[\w$]+\)\}let ([\w$]+)=[\w$]+\(\2,\4\);if\(\8!==null\)return \8;let ([\w$]+)=[\w$]+\(\2,\4\);return [\w$]+\(\2,\4\)===null\?Math\.min\(\9,[\w$]+\(\2\)\):\9\})/;
  const anchors = [legacy, current];
  const matches = anchors.flatMap(anchor => [...source.matchAll(new RegExp(anchor.source, 'g'))]);
  if (matches.length === 0) return { content: source, result: result('FAIL', 'anchor not found') };
  if (matches.length > 1) {
    return {
      content: source,
      result: result('FAIL', 'anchor matched ' + matches.length + ' functions (expected 1)'),
    };
  }
  const match = matches[0]!;
  const body = match[0].slice(match[1]!.length);
  const offset = match.index!;
  const replacement = match[1]! + contextSnippet(match[2]!, contextByKey) + body;
  const content = source.slice(0, offset) + replacement + source.slice(offset + match[0].length);
  return content === source
    ? { content: source, result: result('FAIL', 'replacement made no change') }
    : { content, result: result('OK') };
}
