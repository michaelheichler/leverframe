import type { PatchSiteResult } from './patch-transforms.js';

interface PickerOption {
  value: string;
  label: string;
  description: string;
  badge?: string;
}

const MARKER = '/*ccpatch:model-picker-options*/';
const VARIABLE = '__lfcModelPickerOptions';
const NAME = 'PATCH 5: model picker options';
const EXISTING = /\/\*ccpatch:model-picker-options\*\/var __lfcModelPickerOptions=JSON\.parse\("(?:[^"\\]|\\.)*"\);__lfcModelPickerOptions\.forEach\(function\(_o\)\{if\(!([\w$]+)\.some\(function\(_i\)\{return _i\.value===_o\.value\}\)\)\1\.push\(_o\)\}\);/g;
const ACTIVE = /function [\w$]+\([\w$]+,[\w$]+\)\{let ([\w$]+)=[\w$]+\([^)]*\),([\w$]+)=\1\?\?[\w$]+\([^)]*\),[^;]{0,500}?\.ANTHROPIC_CUSTOM_MODEL_OPTION[^;]{0,500}?;/g;
const LEGACY = /(function [\w$]+\(e,[\w$]+,[\w$]+\)\{let [^{}]{0,400}?;for\(let [\w$]+ of [\w$]+\)[\w$]+\(e,[\w$]+,[\w$]+\);)(return e\})/g;

function outcome(content: string, status: PatchSiteResult['status'], extra?: string) {
  const result = extra === undefined ? { status, name: NAME } : { status, name: NAME, extra };
  return { content, result };
}

function injection(options: PickerOption[], list: string): string {
  const encoded = JSON.stringify(JSON.stringify(options));
  return MARKER + 'var ' + VARIABLE + '=JSON.parse(' + encoded + ');'
    + VARIABLE + '.forEach(function(_o){if(!' + list
    + '.some(function(_i){return _i.value===_o.value}))' + list + '.push(_o)});';
}

export function applyModelPickerOptions(source: string, options: PickerOption[]) {
  if (options.length === 0) return outcome(source, 'SKIP', 'no configured model identities');
  const existing = [...source.matchAll(EXISTING)];
  const markerCount = source.split(MARKER).length - 1;
  if (markerCount !== existing.length || markerCount > 1) {
    return outcome(source, 'FAIL', 'existing picker injection is malformed or duplicated');
  }
  const clean = source.replace(EXISTING, '');
  const active = [...clean.matchAll(ACTIVE)];
  if (active.length > 1) return outcome(source, 'FAIL', 'active picker anchor is ambiguous');
  let content: string;
  if (active.length === 1) {
    const match = active[0]!;
    content = clean.slice(0, match.index) + match[0] + injection(options, match[2]!)
      + clean.slice(match.index + match[0].length);
  } else {
    const legacy = [...clean.matchAll(LEGACY)];
    if (legacy.length !== 1) return outcome(source, 'FAIL', 'picker anchor missing or ambiguous');
    content = clean.replace(LEGACY, (_match, head: string, tail: string) => head + injection(options, 'e') + tail);
  }
  return content === source ? outcome(content, 'SKIP', 'already integrated') : outcome(content, 'OK');
}
